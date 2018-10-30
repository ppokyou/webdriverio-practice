var systest_server = require('../systest_server');
var assert = require('assert');

describe('TruClient', function () {
	describe('#TC chromium replay', function () {
		it('replay script', function (done) {
			systest_server.systest_server();

		});
	});
});