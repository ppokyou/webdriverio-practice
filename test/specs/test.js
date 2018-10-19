var assert = require('assert');
var expect = require('chai').expect;

describe('webdriver.io page', function() {
    it('should be able to filter for commands', function () {
        browser.url('/api.html');

        // filtering property commands
        $('.searchbar input').setValue('getT');

        // get all results that are displayed
        var results = $$('.commands.property a').filter(function (link) {
            return link.isVisible();
        });

        // assert number of results
        expect(results.length).to.be.equal(3);

        // check out second result
        results[1].click();
        expect($('.doc h1').getText()).to.be.equal('GETTEXT');
	});
	
	it('should have the right title - the fancy generator way', function () {
        browser.url('http://webdriver.io');
        var title = browser.getTitle();
        assert.equal(title, 'WebdriverIO - WebDriver bindings for Node.js');
    });
});

describe('DuckDuckGo search', function() {
    it('searches for WebdriverIO', function() {
        browser.url('https://duckduckgo.com/');
        browser.setValue('#search_form_input_homepage', 'WebdriverIO');
        browser.click('#search_button_homepage');

        var title = browser.getTitle();
        console.log('Title is: ' + title);
        // outputs: "Title is: WebdriverIO (Software) at DuckDuckGo"
    });
});