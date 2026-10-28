/**
 * RSS Live Links - an RSS "live bookmark" extension for Google Chrome
 * 
 * Copyright 2010 Martin Bartlett
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

/*
 * "tab_<tabid>" -> array of feed objects
 * Explicitly on window so background.js can access them (same offscreen document context)
 */
window.tabFeeds = {};

/*
 * feed URL -> {feed: feed object, tabCount: number of tabs publishing it}
 */
window.tabFeedsByURL = {};

var unsubscribedIcon = false;

function checkBrowserIcon(force) {
	var needUpdate = force;
	if (options.useAvailableIcon) {
		var unsubscribed = false;
		for (url in window.tabFeedsByURL) {
			if (feedInfo.feedsByURL[url] == undefined) {
				unsubscribed = true;
			}
		}
		if (unsubscribed != unsubscribedIcon) {
			gfx.src = (unsubscribed ? "img/rssll_plus_rss19x19.png" : "img/rssll_19x19.png");
			needUpdate = true;
			unsubscribedIcon = unsubscribed;
		}
	} else {
		if (gfx.src != "img/rssll_19x19.png") {
			gfx.src = "img/rssll_19x19.png";
			needUpdate = true;
		}
	}
	if (needUpdate) {
		setButtonTitle(badgeCount, badgeErrors);
	}
}
