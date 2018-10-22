var webdriverjs = require('webdriverio');
var assert = require('assert');

describe('百度测试', function () {
	this.timeout(99999999);
	var client = {};

	before(function (done) {
		client = webdriverjs.remote({
			desiredCapabilities: {
				browserName: 'chrome',
				IsJavaScriptEnabled: true
			}
		});
		client.init(done);
	});

	it('搜索 Node.js', function (done) {
		try {

			client
				.url('http://www.jd.com/')
				.timeoutsAsyncScript(10000)
				.timeoutsImplicitWait(10000)
				.click('#key')
				.pause(3000)
				.timeoutsAsyncScript(10000)
				.timeoutsImplicitWait(10000)
				.setValue('#key', 'lumia 1520')
				.click('#key+.button')
				.pause(3000)
				.timeoutsAsyncScript(10000)
				.timeoutsImplicitWait(10000)
				.getText('div.mt h1', function (err, text) {
					console.log(text);

					assert(text, 'lumia 1520 商品筛选');

				})
				.call(done);


		} catch (e) {
			console.log(e);
		}

	});

	after(function (done) {

		client.end(done);
	});
});