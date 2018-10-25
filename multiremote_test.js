var webdriverio = require('webdriverio');
var browser = webdriverio.multiremote({
	myChromeBrowser: {
		desiredCapabilities: {
			browserName: 'chrome'
		}
	},
	myFirefoxBrowser: {
		desiredCapabilities: {
			browserName: 'firefox'
		}
	}
});

browser
	.init()
	.url('https://www.whatismybrowser.com/')
	.getText('.string-major').then(function (result) {
		console.log(result.resultChrome); // returns: 'Chrome 40 on Mac OS X (Yosemite)'
		console.log(result.resultFirefox); // returns: 'Firefox 35 on Mac OS X (Yosemite)'
	})
	.end();

var myChromeBrowser = browser.select('myChromeBrowser');
var myFirefoxBrowser = browser.select('myFirefoxBrowser');

myChromeBrowser
	.setValue('#message', 'Hi, I am Chrome')
	.click('#send');

myFirefoxBrowser
	.waitForExist('.messages', 5000)
	.getText('.messages').then(function (messages) {
		assert.equal(messages, 'Hi, I am Chrome');
	});
// browser.init().url('https://duckduckgo.com/');

// // do something with the Chrome browser
// myChromeBrowser.setValue('.chatMessage', 'Hey Whats up!').keys('Enter')

// // do something with the Firefox browser
// myFirefoxBrowser.getText('.message').then(function (message) {
// 	console.log(messages);
// 	// returns: "Hey Whats up!"
// });

// // now sync instances again
// browser.sync().url('http://anotherwebsite.com');