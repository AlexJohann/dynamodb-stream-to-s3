'use strict';
const CONFIG = require('../config.json');
const _ = require('lodash');
const s3 = require('./Aws.js').s3();
const dbClient = require('./Aws.js').dbClient();
const db = require('./Aws.js').db();
const util = require('./Util.js');

let logString = '';

let event = {};
event.table = process.argv[2];
event.execute = process.argv[3];

execute((res) => {
    util.logMessage('', logString, 1)
    util.logMessage(res.message, logString, 1)
})

function execute(callback) {
    util.logMessage('', logString, 1)
    util.logMessage('INTEGRITY CHECK STARTED', logString, 1)

    util.checkArgs([{
        var: event.table,
        status: '#TABLE_NOTFOUND',
        message: 'DynamoDB TABLE WAS NOT INFORMED'
    }])
        .then(() => getTableSchema(event))
        .then(() => getInvalidObjects(event))
        .then(() => putObjects(event))
        .then(res => endRequest(res, event))
        .then(() => callback({
            status: 'ok',
            message: 'INTEGRITY CHECK FINISHED'
        }))
        .catch(err => {
            callback(err)
        })
}

function getTableSchema(event) {
    return new Promise((resolve, reject) => {
        db.describeTable({
            TableName: event.table
        }, (err, data) => {
            if (err) return reject({
                status: 'error',
                message: 'TABLE NOT FOUND'
            });
            else {
                event.table = {};
                event.table.name = data.Table.TableName;
                event.table.keys = data.Table.KeySchema;
                event.table.itemCount = data.Table.ItemCount;
                return resolve();
            }
        })
    })
}

function getInvalidObjects(event) {
    return new Promise((resolve, reject) => {
        scan('errors', event, {
            TableName: event.table.name,
            Limit: 100
        })
            .then(res => {
                event.objects = res;
                return resolve();
            })
            .catch(err => {
                return reject(err);
            })
    })
}

function scan(env, event, parm) {
    return new Promise((resolve, reject) => {
        if (env === 'errors') scanErrors(event, parm, [], resolve, reject);
        else execScan(event, parm, list = [], resolve, reject);
    });
}

function scanErrors(event, parm, list = [], resolve, reject) {
    dbClient.scan(parm, (err, res) => {
        if (err) return reject(`#ERROR_SCAN_ERRORS_${parm.TableName}`, err);

        let promises = [];
        res.Items.forEach(i => {
            let filename = getFilename(event, i);

            if (!filename) return reject({
                status: '#FILENAME_NOTFOUND',
                message: 'Check your configured keys for this table.'
            })

            promises.push(searchObjectsToBackup(CONFIG.bucket, `${event.table.name}/${filename}`, i))
        });

        Promise.all(promises)
            .then(values => {
                if (res.LastEvaluatedKey) {
                    parm.ExclusiveStartKey = res.LastEvaluatedKey;

                    if (values && _.isArray(values)) {
                        values = values.filter(v => v !== undefined && v !== null);
                        list = list.concat(values);
                    }
                    return scanErrors(event, parm, list, resolve, reject);
                } else {

                    if (values && _.isArray(values)) {
                        values = values.filter(v => v !== undefined && v !== null);
                        list = list.concat(values);
                    }

                    return resolve(list);
                }
            })
    });
}

function searchObjectsToBackup(bucket, key, obj, returnObj = null) {
    return new Promise((resolve, reject) => {
        util.getObject({
            Bucket: bucket,
            Key: key
        }).then(res => {
            if (res.Body) {
                res.Body = JSON.parse(res.Body.toString());
                (_.isEqual(res.Body, obj)) ? null : returnObj = obj;
            }

            if (returnObj) {
                util.logMessage(key + ' - DIFF', logString);
                resolve(returnObj);
            }

            resolve();

        }).catch(err => {
            util.logMessage(key + ' - NOT FOUND', logString);
            returnObj = obj;
            resolve(returnObj);
        })
    })
}

function putObjects(event) {
    return new Promise((resolve, reject) => {
        if (!event.execute) return resolve();

        let count = event.objects.length;
        let countSuccess = 0;
        let listErrors = [];
        if (_.isEmpty(event.objects) || !_.isArray(event.objects)) return reject({
            status: '#OBJECTS_NOT_FOUND',
            message: 'NOTHING TO DO'
        });

        util.logMessage('', logString, 1)

        event.objects.forEach(obj => {

            let filename = getFilename(event, obj);

            if (!filename) return reject({
                status: '#FILENAME_NOTFOUND',
                message: 'Note: Check your configured keys for this table.'
            })

            util.putObject({
                Bucket: CONFIG.bucket,
                Key: `${event.table.name}/${filename}`,
                Body: Buffer.from(JSON.stringify(obj))
            })
                .then(res => {
                    util.logMessage(`${event.table.name}/${filename} - PUT SUCCESS`, logString);
                    count--;
                    countSuccess++;
                    if (count == 0) return resolve({
                        listErrors,
                        countSuccess
                    });
                })
                .catch(err => {
                    util.logMessage(`${event.table.name}/${filename} - PUT FAILED`, logString);
                    listErrors.push(obj);
                    count--;
                    if (count == 0) return resolve({
                        listErrors,
                        countSuccess
                    });
                })
        })
    })
}

function execScan(event, parm, list = [], resolve, reject) {
    dbClient.scan(parm, (err, res) => {
        if (err) return reject(`#ERROR_SCAN_${parm.TableName}`);

        res.Items.forEach(i => {
            list.push(i);
        });

        if (res.LastEvaluatedKey) {
            parm.ExclusiveStartKey = res.LastEvaluatedKey;
            return execScan(event, parm, list, resolve, reject);
        } else {
            return resolve(list);
        }
    });
}

function getFilename(event, obj) {
    if (_.isObject(obj)) {
        let filename;
        let key;

        if (!_.get(CONFIG, [ 'tables', event.table.name ])) return null;

        let configKeys = _.get(CONFIG, ['tables', event.table.name]);

        if (_.size(configKeys) === 1) {
            if (event.table.keys[0].AttributeName !== configKeys.key) return null;

            key = event.table.keys[0].AttributeName;
            filename = obj[key];

        } else {
            let values = [event.table.keys[0].AttributeName, event.table.keys[1].AttributeName];

            if (!_.isEqual(values.sort(), _.values(configKeys).sort())) return null;

            filename = `${obj[configKeys.key]}||${obj[configKeys.sortKey]}`
        }

        filename = filename.replace(/[^a-z0-9 | . _ - @]/gi, '-');

        return filename
    }
    return null;
}

function endRequest(res, event) {
    return new Promise((resolve, reject) => {
        if (!_.isEmpty(res) && event.execute) {
            util.logMessage('', logString, 1);
            util.logMessage('PUT ERRORS LENGTH ==> ' + res.listErrors.length, logString);
            util.logMessage('PUT SUCCESS LENGTH ==> ' + res.countSuccess, logString);
        } else if (event.execute) {
            util.logMessage('PUT ERRORS 0', logString);
        }

        return resolve();
    })
}