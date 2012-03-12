var LoadBalancer = require('../lib/load_balancer')
  , Logger = require('../lib/logger')
  , Meeting = require('../models/meeting')
  , Nagios = require('../lib/nagios')
  , Server = require('../models/server')
  , Utils = require('../lib/utils')
  , config = require('../config')
  , request = require('request')
  , sha1 = require('sha1')
  , url = require('url');


// HELPERS

// Validates the checksum in the request 'req'.
// If it doesn't match the expected checksum, we'll send
// an XML response with an error code just like BBB does and
// return false. Returns true if the checksum matches.
exports.validateChecksum = function(req, res){
  var method, query, salt, urlObj, checksum;

  urlObj = url.parse(req.url, true);
  checksum = urlObj.query['checksum'];
  delete urlObj.search; // so the next line has effect
  delete urlObj.query['checksum'];

  // get the expected checksum
  // note: the url query is already encoded, howerver BBB expects a ' ' to
  // be encoded as '+', but any ' ' or '+' in the query are replaced by
  // '%20' in the 'url.parse()' call above
  query = Utils.bbbQueryFromUrl(urlObj).replace(/%20/g, '+');
  method = Utils.bbbMethodFromUrl(urlObj);
  salt = config.lb.salt;
  correctChecksum = sha1(method + query + salt);

  // matches the checksum
  if (checksum != correctChecksum) {
    Logger.log('checksum check failed, sending a checksumError response');
    res.contentType('xml');
    res.send(config.bbb.responses.checksumError);
    return false;
  }
  return true;
};

// Basic handler that tries to find the meeting using the meetingID provided
// in the request and checks the checksum. If the meeting is not found or the
// checksum is incorrect it responds with an error.
// Otherwise it calls the callback 'fn'.
exports.basicHandler = function(req, res, fn){
  if (!exports.validateChecksum(req, res)) return;

  urlObj = url.parse(req.url, true);
  var m_id = urlObj.query['meetingID'];
  Logger.log(urlObj.pathname + ' request with: ' + JSON.stringify(urlObj.query), m_id);

  Meeting.get(m_id, function(err, meeting){
    if (!meeting) {
      Logger.log('failed to find meeting', m_id);

      // we'll use the default server to get a proper anwser from BBB
      // usually it will be an XML with an error code
      LoadBalancer.defaultServer(function(server) {
        if (server != undefined) {
          Logger.log('redirecting to the default server ' + server.name, m_id);
          LoadBalancer.handle(req, res, server, config.lb.proxy);
        } else {
          Logger.log('there\'s no default server, sending an invalidMeeting response', m_id);
          res.contentType('xml');
          res.send(config.bbb.responses.invalidMeeting);
        }
      });

      return false;
    }

    fn(meeting);
  });
};


// ROUTES HANDLERS

// General index
exports.index = function(req, res){
  res.render('index', { title: 'Mconf - BigBlueButton Load Balancer' })
};

// BBB api index
exports.apiIndex = function(req, res){
  res.contentType('xml');
  res.send(config.bbb.responses.apiIndex);
};

// Routing a 'create' request
exports.create = function(req, res){
  if (!exports.validateChecksum(req, res)) return;

  urlObj = url.parse(req.url, true);
  var m_id = urlObj.query['meetingID'];
  Logger.log(urlObj.pathname + ' request with: ' + JSON.stringify(urlObj.query), m_id);

  Meeting.get(m_id, function(err, meeting){

    // the meeting is not being proxied yet
    if (!meeting) {
      Logger.log('failed to load meeting', m_id);

      var server = LoadBalancer.selectServer();
      meeting = new Meeting(m_id, server);
      meeting.save();
    }

    Logger.log('successfully loaded meeting', m_id);
    Logger.log('server selected ' + meeting.server.url, m_id);

    LoadBalancer.handle(req, res, meeting.server, config.lb.proxy);
  });
};

// Routing a 'join' request
exports.join = function(req, res){
  exports.basicHandler(req, res, function(meeting) {
    // always redirect, never proxy
    LoadBalancer.handle(req, res, meeting.server, false);
  });
};

// Routing a 'getMeetings' request
exports.getMeetings = function(req, res){
  var server
    , id
    , responses = 0
    , count = 0;

  if (!exports.validateChecksum(req, res)) return;

  Server.count(function(err, c) { count = c; });

  // send a getMeetings to each server and concatenate the responses
  Server.all(function(err, servers) {
    for (id in servers) {
      server = servers[id];

      opt = { url: LoadBalancer.changeServerInUrl(req.url, server) }
      Logger.log('sending getMeetings to ' + opt['url']);
      request(opt, function(error, response, body) {
        responses++;

        if (error) {
          Logger.log('error calling getMeetings to ' + server.name + ': ' + error);
        } else {
          // TODO: parse the response and concatenate the servers
          Logger.log('got the response to getMeetings from ' + server.name + ':');
          Logger.log(body);
        }

        // got all the responses, send to the user
        if (responses == count) {
          res.contentType('xml');
          res.send(body);
        }

      });

    }
  });
};

// Routing any request that simply needs to be passed to a BBB server
exports.anything = function(req, res){
  exports.basicHandler(req, res, function(meeting) {
    LoadBalancer.handle(req, res, meeting.server, config.lb.proxy);
  });
};
