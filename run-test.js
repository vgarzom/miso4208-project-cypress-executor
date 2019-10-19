const cypress = require('cypress');
const mongoose = require('mongoose');
const TestObject = require("./models/TestObject.model");
const fs = require('fs');

const fileRoot = './cypress/integration/';

const db_connection = process.env.miso4208_exam1_db;
// Load the SDK para JavaScript
var AWS = require('aws-sdk');
// Set the Region 
AWS.config.update({
  secretAccessKey: process.env.koko_secret_key,
  accessKeyId: process.env.koko_key_id,
  region: 'us-east-1'
});


// Create an SQS service 
const queueURL = process.env.koko_sqs_cypress_url;
const sqs = new AWS.SQS({ apiVersion: '2012-11-05' });

//Configure s3 access
var bucketName = process.env.koko_data_bucket;
var s3 = new AWS.S3({ apiVersion: '2006-03-01' })

var params = {
  AttributeNames: [
    "SentTimestamp"
  ],
  MaxNumberOfMessages: 1,
  MessageAttributeNames: [
    "All"
  ],
  QueueUrl: queueURL,
  VisibilityTimeout: 20,
  WaitTimeSeconds: 10
};

const test_aggregation = [{
  $lookup: {
    from: 'test-cases',
    localField: 'case_id',
    foreignField: '_id',
    as: 'case'
  }
}, {
  $unwind: "$case"
}, {
  $lookup: {
    from: 'appcompilationmodels',
    localField: 'app_compilation_id',
    foreignField: '_id',
    as: 'compilation'
  }
}, {
  $unwind: "$compilation"
}];


// Mongoose configuration
mongoose.Promise = require('bluebird');

function connectDb() {
  mongoose.connect(db_connection, { useNewUrlParser: true, promiseLibrary: require('bluebird') })
    .then(() => {
      console.log('connection to database succesful');
      init();
    })
    .catch((err) => {
      console.error(err);
      setTimeout(() => { connectDb }, 5000);
    });
}

function receiveMessage(callback) {
  sqs.receiveMessage(params, function (err, data) {
    if (err) {
      console.log("Receive Error", err);
      callback(false);
    } else if (data.Messages && data.Messages.length > 0) {
      const testid = JSON.parse(data.Messages[0].Body)['test_id'];
      console.log("test found", testid);
      getTestData(testid, data.Messages[0]);
      callback(true);
    } else {
      callback(false);
    }
  });
}

function getTestData(testId, message) {
  let aggregation = [{ $match: { _id: mongoose.Types.ObjectId(testId) } }];
  TestObject.aggregate(aggregation.concat(test_aggregation), (err, testObjects) => {
    if (err) {
      //res.json({ code: 400, message: "Error consultando", error: err })
      console.log("error", err);
      init();
    } else if (testObjects.length > 0) {
      executeTest(testObjects[0], (result) => {
        deleteMessage(message, (r) => { init(); });
      })
    } else {
      console.log("Test not found");
      deleteMessage(message, (result) => { init(); })
    }
  });
}

function copyFile(file_name, callback) {
  try {
    if (fs.existsSync(`${fileRoot}${file_name}`)) {
      console.log("file already exists!");
      callback(true);
    } else {
      console.log("file does not exist. Copying from bucket");
      s3.getObject({ Bucket: bucketName, Key: `test-cases/cypress/${file_name}` }, function (err, data) {
        if (err) {
          console.log("No fue posible cargar el archivo");
          callback(false)
        } else {
          fs.writeFileSync(`${fileRoot}${file_name}`, data.Body.toString('ascii'));
          callback(true);
        }
      });
    }
  } catch (err) {
    console.error("error", err);
    callback(false)
  }

}

function executeTest(test, callback) {
  TestObject.findByIdAndUpdate(test._id, { status: 'in-progress' }, (err, res) => {
    if (err) console.log("Error updating document status");
    else console.log("Document status updated!");
  });

  copyFile(test.case.file_name, (copyresult) => {
    if (copyresult) {
      cypress.run({
        spec: `${fileRoot}${test.case.file_name}`,
        config: {
          video: false
        }
      })
        .then((results) => {
          console.log("results", results);
          callback(true);
          let data = results.runs[0];
          let id = makeid(12);
          if (data.error === null) {
            data.screenshots.map((s, i) => {
              s.name = `${id}_${i}.png`;
              uploadFile(s.path, s.name);
            });

            test.reporterStats = data.reporterStats;
            test.error = data.error;
            test.screenshots = data.screenshots;
            if (test.reporterStats.passes === test.reporterStats.tests) {
              test.status = "success";
            } else {
              test.status = "failed";
            }

            TestObject.findByIdAndUpdate(test._id, test, (err, res) => {
              if (err) console.log("Error updating document");
              else console.log("Document updated!");
            })

          } else {
            callback(true);
          }
        })
        .catch((err) => {
          console.log("err", err);
          callback(false);
        });
    } else {
      callback(false);
    }
  })

}

function deleteMessage(message, callback) {
  var deleteParams = {
    QueueUrl: queueURL,
    ReceiptHandle: message.ReceiptHandle
  };
  sqs.deleteMessage(deleteParams, function (err, data) {
    if (err) {
      console.log("Delete Error", err);
      callback(false);
    } else {
      console.log("Message Deleted", data);
      callback(true);
    }
  });
}

const uploadFile = (filePath, file_name) => {
  fs.readFile(filePath, (err, data) => {
    if (err) console.error(err);
    var base64data = new Buffer(data, 'binary');
    var params = {
      Bucket: bucketName,
      Key: `images/${file_name}`,
      Body: base64data,
      ACL: 'public-read'
    };
    s3.upload(params, (err, data) => {
      if (err) console.error(`Upload Error ${err}`);
      console.log('Upload Completed');
      //Remove original file
      fs.unlink(filePath, (err) => {
        if (err) {
          console.error(err)
        }
      })
    });
  });
};

function makeid(length) {
  var result = '';
  var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var charactersLength = characters.length;
  for (var i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}

function init() {
  receiveMessage((result) => {
    if (!result) {
      console.log("not message found, waiting...");
      setTimeout(() => { init(); }, 10000);
    } else {
      console.log("Test is performing...")
    }
  })
}


connectDb();
