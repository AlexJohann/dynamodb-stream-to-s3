'use strict';
const CONFIG = require('../config.json');
const _ = require('lodash');
const s3 = require('../utils/Aws.js').s3();
const util = require('../utils/Util.js');
const unmarshalItem = require('dynamodb-marshaler').unmarshalItem;

module.exports.run = (event, context, callback) => {
  util.logMessage('-----------TRIGGER START-----------')
  util.logMessage('--------------EVENT----------------')
  util.logMessage(JSON.stringify(event))

  getTable(event)
    .then(() => getRecords(event))
    .then(() => setRecords(event))
    .then(() => callback(null, {
      status: 200
    }))
    .catch(err => {
      util.sendResultErro(err, callback)
    })
}

function getTable(event) {
  return new Promise((resolve, reject) => {
    event.Records.forEach(record => {
      if (!_.has(event, 'table')) event.table = record.eventSourceARN;
    });

    event.table = event.table.split(':table/')[1];
    event.table = event.table.split('/')[0];

    util.logMessage('EVENT TABLE ==> ' + event.table);

    if (event.table) return resolve();
    return reject({ status: '#ERROR_GET_TABLE' })
  })
}

function getRecords(event) {
  return new Promise((resolve, reject) => {
    let count = event.Records.length;
    event.objects = [];

    event.Records.forEach(record => {
      let filename = null;
      record.dynamodb.Keys = [record.dynamodb.Keys]
      record.dynamodb.Keys = record.dynamodb.Keys.map(unmarshalItem)[0];

      if (_.get(CONFIG, `tables.${event.table}`)) {
        let configKeys = _.get(CONFIG, `tables.${event.table}`);
        let streamKeys = _.keys(record.dynamodb.Keys);

        util.logMessage('KEYS => ' + JSON.stringify(configKeys));
        util.logMessage('STREAM KEYS => ' + JSON.stringify(streamKeys));
        
        if (_.size(configKeys) === 2) {
          let key = configKeys.key;
          let sortKey = configKeys.sortKey;

          if (_.isEqual(streamKeys.sort(), _.values(configKeys).sort())) {
            filename = `${record.dynamodb.Keys[key]}||${record.dynamodb.Keys[sortKey]}`;
          } else {
            return reject({ status: '#KEYS_DOESNT_MATCH' })
          }

        } else {
          if (_.isEqual(streamKeys.sort(), _.values(configKeys).sort())) {
            let key = configKeys.key;
            filename = record.dynamodb.Keys[key];
          } else {
            return reject({ status: '#KEYS_DOESNT_MATCH' })
          }

        }
      } else return reject({ status: '#KEYS_NOT_FOUND' })

      util.logMessage('EVENTNAME => ' + record.eventName);

      filename = filename.replace(/[^a-z0-9 | . _ - @]/gi, '-');

      util.logMessage('FILENAME => ' + filename);

      if (record.eventName == 'REMOVE' && filename) {
        event.objects.push({
          excludeFile: {
            Bucket: CONFIG.bucket,
            Key: `${event.table}/${filename}`
          }
        })
      } else if (_.has(record.dynamodb, 'NewImage') && filename) {
        record.dynamodb.NewImage = [record.dynamodb.NewImage];
        record.dynamodb.NewImage = record.dynamodb.NewImage.map(unmarshalItem)[0];

        event.objects.push({
          putFile: {
            Bucket: CONFIG.bucket,
            Key: `${event.table}/${filename}`,
            Body: Buffer.from(JSON.stringify(record.dynamodb.NewImage))
          }
        })
        util.logMessage('NEWIMAGE => ' + JSON.stringify(record.dynamodb.NewImage));
      }
      count--;
    })

    if (count == 0) return resolve();
  })
}

function setRecords(event) {
  return new Promise((resolve, reject) => {
    let count = event.objects.length;
    event.objects.forEach(record => {
      if (_.has(record, 'putFile')) {
        util.logMessage('RECORD TO PUT ==>' + JSON.stringify(record))
        util.putObject(record.putFile)
          .then(res => {
            util.logMessage('PUT SUCCESS ==>' + JSON.stringify(record))
            count--;
            if (count == 0) return resolve();
          })
          .catch(err => {
            util.logMessage('FAILED TO PUT ==>' + JSON.stringify(record))
            count--;
            if (count == 0) return resolve();
          })
      } else if (_.has(record, 'excludeFile')) {
        util.logMessage('RECORD TO REMOVE ==>' + JSON.stringify(record))

        util.deleteObject(record.excludeFile)
          .then(res => {
            util.logMessage('REMOVED ==>' + JSON.stringify(record))
            count--;
            if (count == 0) return resolve();
          })
          .catch(err => {
            util.logMessage('FAILED TO REMOVE ==>' + JSON.stringify(record))
            console.log('ERROR ==>', err);
            count--;
            if (count == 0) return resolve();
          })
      }
    })
  })
}
