"use strict";


var _ = require('lodash'),
  mongoose = require('mongoose'),
  path = require('path'),
  thunkify = require('thunkify');

var waigo = require('waigo'),
  schema = waigo.load('support/db/mongoose/schema'),
  exec = waigo.load('support/exec-then');


var jobSchema = schema.create({
  trigger: { type: mongoose.Schema.Types.ObjectId, ref: 'Trigger' },
  source: String,
  queryParams: { type: mongoose.Schema.Types.Mixed, default: {} },
  status: { type: String, default: 'created' },
  created_at: { type: Date, default: Date.now }
});




jobSchema.method('_save', function*() {
  yield thunkify(this.save).call(this);
});



/**
 * Execute this job.
 *
 * @param {Object} req Request context.
 */
jobSchema.method('execute', function*() {
  this.status = 'processing';
  yield this._save();

  yield this.log('Triggered from ' + this.source, {
    data: this.queryParams
  });

  try {
    var app = waigo.load('application').app;

    // trigger
    var trigger = yield app.models.Trigger.getOne(this.trigger);

    // trigger type
    var triggerType = new app.triggerTypes[trigger.type];

    // playbook
    var playbook = yield app.models.Playbook.getOne(this.trigger.playbook);
    if (!playbook) {
      throw new Error('Playbook not found');
    }

    // let trigger type perform its checks
    var buildVariables = 
      yield triggerType.process(this.trigger.configParams, this.queryParams);

    yield this.log('Ansible variables: ' + JSON.stringify(buildVariables), { console: true });

    // build --extra-vars parameter string
    var extraVars = [];
    for (let key in buildVariables) {
      extraVars.push(key + '=' + buildVariables[key]);
    }

    // build final command
    var cmd = [ 
      path.join(app.config.ansibleSource, 'bin', 'ansible-playbook'),
      '-v',
      '-i ' + path.join(app.config.ansiblePlaybooks, 'hosts'),
      '--extra-vars=' + extraVars.join(','),
      playbook.path
    ].join(' ');

    yield this.log(cmd, { console: true });

    // execute
    var result = yield exec(cmd, {
      outputTimeout: 60,
      env: {
        'ANSIBLE_LIBRARY': path.join(app.config.ansibleSource, 'library'),
        'PYTHONPATH': [
          path.join(app.config.ansibleSource, 'lib'),
          app.config.pythonSitePackages
        ].join(':')
      }
    });

    yield this.log(result.stdout, { console: true });

    yield this.log('Job complete');

    this.result = 'completed';

  } catch (err) {
    if (undefined !== err.code) {
      yield this.log('Exit code: ' + err.code + '\n\n' 
          + err.stdout, { console: true, error: true });
    } else {
      yield this.log(err.message, { error: true });
    }

    yield this.log('Job did not complete');
    this.status = 'failed';
  } finally {
    yield this._save();
  }
});



/**
 * The URL to view this job.
 */
jobSchema.virtual('viewUrl').get(function() {
  return '/jobs/' + this._id;
});



/**
 * Create a log message entry for this trigger.
 * @param  {String} message The status message.
 * @param {Object} meta Additional info about this log.
 */
jobSchema.method('log', function*(message, meta) {
  var app = waigo.load('application').app;

  var log = new app.models.Log({
    job: this._id,
    trigger: this.trigger,
    text: message,
    meta: meta || {}
  });

  yield thunkify(log.save).call(log);
});


/**
 * @override
 */
jobSchema.method('viewObjectKeys', function(ctx) {
  return ['_id', 'trigger', 'source', 'queryParams', 
                'status', 'created_at', 'viewUrl'];
});



/** 
 * Find active jobs.
 * @return {Promise} 
 */
jobSchema.static('getActive', function() {
  return this.find({
    status: { '$in': ['created', 'processing'] }
  }).sort({created_at: -1}).populate('trigger').exec();
});



/** 
 * Find pending jobs.
 * @return {Promise} 
 */
jobSchema.static('getPending', function(limit) {
  return this.find({
    status: 'created'
  }).sort({created_at: -1}).populate('trigger').limit(limit || 1000).exec();
});



/**
 * Get for trigger
 * @return {Promise} 
 */
jobSchema.static('getForTrigger', function(triggerId) {
  return this.find({
    trigger: triggerId
  }).sort({created_at: -1}).populate('trigger').exec();
});



/**
 * Get a job
 * @return {Promise} 
 */
jobSchema.static('getOne', function(id) {
  return this.findById(id).populate('trigger').exec();
});




module.exports = function(dbConn) {
  return dbConn.model('Job', jobSchema);
}
