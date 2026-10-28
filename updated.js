/**
 * RSS Live Links - an RSS "live bookmark" extension for Google Chrome
 *
 * Copyright 2012 Martin Bartlett
 *
 *    This file is part of RSS Live Links.
 *
 *    RSS Live Links is free software: you can redistribute it and/or modify
 *    it under the terms of the GNU Lesser General Public License as published by
 *    the Free Software Foundation, either version 3 of the License, or
 *    (at your option) any later version.
 *
 *    RSS Live Links is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Lesser General Public License for more details.
 *
 *    You should have received a copy of the GNU Lesser General Public License
 *    along with RSS Live Links.  If not, see <http://www.gnu.org/licenses/>.
 *
 * @version 1.0.0
 * @license GNU Lesser General Public License, http://www.gnu.org/copyleft/lesser.html
 * @author  Martin Bartlett
 */
var opt_link = 'options.html'
var bug_link = 'https://chrome.google.com/webstore/support/hcamnijgggppihioleoenjmlnakejdph'
var rln_link = 'https://docs.google.com/View?docid=dhfscm8k_780x6nkpwgk'
var doc_link = 'https://docs.google.com/View?id=dhfscm8k_764dnw3srhd'
var xmk_link = 'https://chrome.google.com/webstore/detail/ajpgkpeckebdhofmmjfgcjjiiejpodla'
var faq_link = 'https://docs.google.com/document/d/1xkhZUUh-ezevyxEtpynfF5iUBTEJD-dGWzRaFelLuW4/edit'
var gcb_link = 'https://code.google.com/p/chromium/issues/detail?id=261140'
function init() {
	window.addEventListener("contextmenu", function () {return false;}, false);
	document.getElementById('rn1').addEventListener("click", function () {showUrl(rln_link, false);}, false);
	document.getElementById('xmk').addEventListener("click", function () {showUrl(xmk_link, false);}, false);
	document.getElementById('rn2').addEventListener("click", function () {showUrl(rln_link, false);}, false);
	document.getElementById('rn3').addEventListener("click", function () {showUrl(rln_link, false);}, false);
	document.getElementById('faq').addEventListener("click", function () {showUrl(faq_link, false);}, false);
	document.getElementById('doc').addEventListener("click", function () {showUrl(doc_link, false);}, false);
	document.getElementById('bug').addEventListener("click", function () {showUrl(bug_link, false);}, false);
	document.getElementById('opt').addEventListener("click", function () {showUrl(opt_link, false);}, false);
	document.getElementById('gcb').addEventListener("click", function () {showUrl(gcb_link, false);}, false);	
	document.getElementById('rssllVersion').innerHTML = chrome.runtime.getManifest().version;
	chrome.action.setPopup({"popup": "popup.html"});
}
function showUrl(url, focus, reuse, callback) {
	chrome.runtime.sendMessage({type: 'rssll_call', fn: 'openInTab', args: [url, false, true, false]});
}
window.onload = init;

chrome.runtime.sendMessage({greeting: "loadedWelcomePage"},
    function (response) {
});