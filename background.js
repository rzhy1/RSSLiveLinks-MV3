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
 *
 * Modified 2026-10-28 by rzhy1: Manifest V3 port (offscreen document), bug
 * fixes, performance work and feed discovery. See NOTICE for the full list.
 */
const CLEANUP_INTERVAL = 15 * 60 * 1000; // 每15分钟清理一次
const validatingTabs = new Set(); // 存放正在验证的 tabId，防止重复验证
const closedTabs = new Set();     // 存放已关闭但可能仍有异步验证在进行中的 tabId（竞态防护）
const probeCache = new Map();     // per-origin 探测缓存: origin → { timestamp, feeds }
const PROBE_CACHE_TTL = 5 * 60 * 1000; // 5 分钟缓存
const PROBE_CACHE_MAX = 200;      // 硬上限：超过则淘汰最旧条目，防止 offscreen 常驻无限增长
window.addEventListener("load", init, false);
var manifest = {version: "unknown"};
var versionChanged = false;
var noAutoUpdates = false;
var inWorker = false;
var options = {
	subscriptions: [],
	groups: {},
	maxItems: 10,
	defaultTtl: 5,
	defaultTimeout: 45,
	unlimitedItems: false,
	sortItemsByDate: false,
	showUnseenFirst: false,
	hideOthersOnOpen: false,
	animateButton: true,
	singleItem: false,
	focusFirstTab: false,
	useAvailableIcon: false,
	popupWidth: 360,
	popupHeight: 800,
	maxConcurrentRequests: 4,
	unlimitedRequests: false,
	showAvailable: true,
	useGroups: false,
	maintainBadge: true,
	storageSizeWarningMade: false,
	sortItems: 0,
	fixPopupClosesBug: false,
	popupDensity: 0,
	styleOptions: {}
};

var currentTimer;
var feedInfo = {feeds: [], feedsByURL: {}};
var lastPopupTab;
var loaded = false;
var updatingCount = 0;
var updating = false;
var seenStates = {}; 
var lastOpenedFeed;
var delayedTabs = [];
var popupStateInfo = {};
var unseenFeedCount = 0;
var errorFeedCount = 0;
var storageSizeWarningMade = false;
var extensionFS;
var xmlHttpRequestManager;
var rssllWebWorker;

function initStep(name, fn) {
	try {
		fn();
	} catch (e) {
		console.error("Init step '" + name + "' failed: " + e);
	}
}

function init() {
	initStep("initExtensionFS", initExtensionFS);
	initStep("initGraphics", initGraphics);
	initStep("getManifest", getManifest);
	initStep("earlyInitBookmarks", earlyInitBookmarks);
	initStep("loadSavedState", loadSavedState);
	initStep("initContextMenus", initContextMenus);
	initStep("setWorkerStrategy", setWorkerStrategy);
	initStep("changeMaxConcurrentRequests", changeMaxConcurrentRequests);
	initStep("autoUpdateFeeds", autoUpdateFeeds);
	// MV3: tabs 事件与查询由 service worker 转发（offscreen 无法直接访问）
	chrome.runtime.sendMessage({type: 'rssll_ui', cmd: 'tabsQueryAll'}, function(resp) {
		void chrome.runtime.lastError;
		if (resp && resp.tabs) {
			addAllTabs(resp.tabs);
		}
	});
	console.log("RSS Live Links loaded");
	initStep("initBookmarks", initBookmarks);
	saveOptions();
	loaded = true;
	setInterval(clearRssCache, CLEANUP_INTERVAL);
	console.log("定期缓存清理已启动，间隔：" + (CLEANUP_INTERVAL / 60000) + "分钟");
}

async function validateFeedCandidates(candidates, tabId, pageUrl) {
    // 即使 candidates 为空也需要处理 —— 有 pageUrl 说明需要主动探测常见 feed 路径
    const hasPageUrl = !!pageUrl;
    if (!candidates || candidates.length === 0) {
        if (!hasPageUrl || validatingTabs.has(tabId)) return;
        validatingTabs.add(tabId);
        closedTabs.delete(tabId);
        
        // ============================================================
        // 路径门控：只在站点根或分区根触发探测，不在每个文章/产品页发 24 个 HEAD
        // 站点根: / /index.html
        // 分区根: /blog /feed /news 等（≤1 个路径段，不含文件扩展名）
        // ============================================================
        let origin, pathname;
        try {
            const u = new URL(pageUrl);
            origin = u.origin;
            pathname = u.pathname;
        } catch(e) {
            origin = pageUrl.replace(/^(https?:\/\/[^\/]+).*/, '$1');
            pathname = '/';
        }
        
        // 判断路径是否够"根"
        // 只保留有意义的路径段：非空、非纯数字文章ID、非单字符、非有扩展名的文件
        const segments = pathname.split('/').filter(s => 
            s && 
            !/^\d+$/.test(s) &&   // 排除纯数字文章ID（如 /1685622）
            !s.includes('.')       // 排除带扩展名的文件路径
        );
        const isSiteRoot = pathname === '/' || pathname === '/index.html' || pathname === '/index.htm';
        // 过滤后如果 segments 为空，说明路径全是纯数字 ID 或空段 → 不算分区根
        const isSectionRoot = segments.length > 0 && segments.length <= 1;
        if (!isSiteRoot && !isSectionRoot) {
            console.log(`[PROBE] Skip probe: pathname "${pathname}" is too deep (not a site/section root)`);
            validatingTabs.delete(tabId);
            // 清理旧数据
            cleanupOldTabFeeds(tabId);
            delete window.tabFeeds["tab_" + tabId];
            return;
        }
        
        // per-origin 缓存检查（5 分钟内同一 origin 不重复探测）
        const cacheEntry = probeCache.get(origin);
        const now = Date.now();
        if (cacheEntry) {
            if ((now - cacheEntry.timestamp) < PROBE_CACHE_TTL) {
                console.log(`[PROBE] Using cached result for ${origin} (${cacheEntry.feeds.length} feeds, ${Math.round((now - cacheEntry.timestamp)/1000)}s old)`);
                validatingTabs.delete(tabId);
                cleanupOldTabFeeds(tabId);
                if (cacheEntry.feeds.length > 0) {
                    window.tabFeeds["tab_" + tabId] = cacheEntry.feeds.map(f => ({...f}));
                    cacheEntry.feeds.forEach(feed => {
                        if (!window.tabFeedsByURL[feed.url]) {
                            window.tabFeedsByURL[feed.url] = { feed, tabCount: 1 };
                        } else {
                            window.tabFeedsByURL[feed.url].tabCount++;
                        }
                    });
                    checkBrowserIcon();
                    pushToPopup({type: 'rssll_event', event: 'tabFeedsSync', tabFeedsByURL: serializeTabFeeds()});
                }
                return;
            }
            // 缓存已过期：立即剔除，避免 offscreen 常驻导致 Map 无限增长
            probeCache.delete(origin);
        }
        
        // 触发主动探测
        const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/feed+json, text/xml, application/xml;q=0.9, */*;q=0.1';
        const probed = await probeFeedPaths(origin, tabId, [], FEED_ACCEPT);
        validatingTabs.delete(tabId);
        
        // 写入缓存
        probeCache.set(origin, { timestamp: now, feeds: probed });
        
        // 清理旧数据 + 写入新数据
        cleanupOldTabFeeds(tabId);
        delete window.tabFeeds["tab_" + tabId];
        
        if (probed.length > 0) {
            console.log(`[VALIDATOR] Empty-candidate probe found ${probed.length} feeds.`);
            window.tabFeeds["tab_" + tabId] = probed;
            probed.forEach(feed => {
                if (!window.tabFeedsByURL[feed.url]) {
                    window.tabFeedsByURL[feed.url] = { feed, tabCount: 1 };
                } else {
                    window.tabFeedsByURL[feed.url].tabCount++;
                }
            });
            checkBrowserIcon();
            pushToPopup({type: 'rssll_event', event: 'tabFeedsSync', tabFeedsByURL: serializeTabFeeds()});
        }
        return;
    }
    if (validatingTabs.has(tabId)) return;
    validatingTabs.add(tabId);
    // 标签页发起了新验证 = 标签还活着，清除关闭标记
    closedTabs.delete(tabId);
    console.log(`[VALIDATOR] Validating ${candidates.length} candidates for tab ${tabId}...`);
    
    // 从第一个候选 URL 或 pageUrl 提取 origin，供后续 probeFeedPaths 使用
    const origin = (pageUrl || candidates[0]?.url || '').replace(/^(https?:\/\/[^\/]+).*/, '$1');
    const pageHost = new URL(origin + '/').hostname;

    const validFeeds = [];
    const feedUrlCheck = new Set();
    // 后台 fetch 需要的 Accept 头 —— 解决 ifanr 这类 content negotiation 站点
    const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/feed+json, text/xml, application/xml;q=0.9, */*;q=0.1';

    for (const candidate of candidates) {
        if (!candidate.url || feedUrlCheck.has(candidate.url)) continue;
        feedUrlCheck.add(candidate.url);

        try {
            // 1. 接受内容脚本直接检测到的源（如XML文档）
            if (candidate.isDirect) {
                console.log(`[VALIDATOR] ACCEPTED (direct detection): ${candidate.url} is a valid feed.`);
                validFeeds.push({
                    name: candidate.name,
                    url: candidate.url,
                    faviconURL: `https://www.google.com/s2/favicons?domain=${new URL(candidate.url).hostname}`
                });
                continue;
            }

            // 2. 改进的验证逻辑
            let isValid = false;
            let format = "unknown";
            let headContentType = '';
            
            // 2.1 先尝试HEAD请求（带 feed Accept 头，解决 content negotiation）
            try {
                const headResponse = await fetch(candidate.url, { 
                    method: 'HEAD',
                    headers: { 'Accept': FEED_ACCEPT },
                    signal: AbortSignal.timeout(5000)
                });
                
                if (!headResponse.ok) {
                    console.log(`[VALIDATOR] HEAD failed (${headResponse.status}), trying GET: ${candidate.url}`);
                } else {
                    headContentType = headResponse.headers.get('content-type') || '';
                    if (isFeedContentType(headContentType)) {
                        isValid = true;
                        format = "HEAD/content-type";
                    }
                }
            } catch (e) {
                console.log(`[VALIDATOR] HEAD error for ${candidate.url}:`, e.message);
            }
            
            // 2.2 如果HEAD失败或content-type不是feed类型，尝试GET部分内容做真正的内容验证
            if (!isValid) {
                const { content } = await fetchPartialContent(candidate.url, 8192);
                format = detectContentFormat(content);
                
                // 特别处理少数派RSS源
                if (candidate.url.includes("sspai.com/feed")) {
                    console.log(`[VALIDATOR] Special handling for SSPAI feed`);
                    isValid = /<rss|<\?xml|feed/i.test(content);
                } 
                // 标准验证逻辑
                else if (format === 'rss' || format === 'atom' || format === 'json-feed') {
                    isValid = true;
                }
                // 宽松的回退检测
                else if (isLikelyFeedContent(content)) {
                    isValid = true;
                    format = "fallback";
                }

                // 监控：如果 HEAD content-type 不是 feed 类型但 GET 内容验证成功，
                // 记录下来方便观察是否有需要补充到白名单的非标 MIME
                if (isValid && headContentType) {
                    console.log(`[VALIDATOR] Feed validated via content (HEAD content-type was "${headContentType}"): ${candidate.url}`);
                }
            }

            // 3. 处理验证结果
            if (isValid) {
                console.log(`[VALIDATOR] SUCCESS (${format}): ${candidate.url} is a valid feed.`);
                validFeeds.push({
                    name: candidate.name,
                    url: candidate.url,
                    faviconURL: `https://www.google.com/s2/favicons?domain=${new URL(candidate.url).hostname}`
                });
            } else {
                console.log(`[VALIDATOR] REJECTED: ${candidate.url} (format: ${format})`);
            }
        } catch (e) {
            console.log(`[VALIDATOR] Skipping candidate ${candidate.url}:`, e.message);
        }
    }

    // 竞态防护：异步验证期间标签页可能已被关闭（tabRemoved 先跑过，无数据可清），
    // 此时写入的结果将永远无法被清理，必须丢弃。
    if (closedTabs.has(tabId)) {
        console.log(`[VALIDATOR] Tab ${tabId} was closed during validation, discarding ${validFeeds.length} feeds.`);
        validatingTabs.delete(tabId);
        return;
    }

    // ============================================================
    // 4. 主动探测回退：如果被动扫描（link/a 标签）没找到任何有效 feed，
    //    对当前 origin 尝试常见 feed 路径。解决 ifanr.com 这类首页不暴露
    //    <link rel="alternate"> 的站点。
    // ============================================================
    if (validFeeds.length === 0 && origin) {
        const probed = await probeFeedPaths(origin, tabId, candidates, FEED_ACCEPT);
        if (probed.length > 0) {
            console.log(`[VALIDATOR] Probe found ${probed.length} feeds!`);
            validFeeds.push(...probed);
        }
    }

    // 清理旧的该标签页的可用源
    if(window.tabFeeds["tab_" + tabId]) {
        window.tabFeeds["tab_" + tabId].forEach(feed => {
            if(window.tabFeedsByURL[feed.url]) {
                window.tabFeedsByURL[feed.url].tabCount--;
                if(window.tabFeedsByURL[feed.url].tabCount <= 0) {
                    delete window.tabFeedsByURL[feed.url];
                }
            }
        });
    }

    // 如果找到了有效的 feed，更新全局状态
    if (validFeeds.length > 0) {
        window.tabFeeds["tab_" + tabId] = validFeeds;
        validFeeds.forEach(feed => {
            if (!window.tabFeedsByURL[feed.url]) {
                window.tabFeedsByURL[feed.url] = { feed: feed, tabCount: 1 };
            } else {
                window.tabFeedsByURL[feed.url].tabCount++;
            }
        });
    } else {
        delete window.tabFeeds["tab_" + tabId];
    }

    checkBrowserIcon(); // 更新浏览器图标状态
    validatingTabs.delete(tabId); // 验证结束，移除锁定
    pushToPopup({type: 'rssll_event', event: 'tabFeedsSync', tabFeedsByURL: serializeTabFeeds()});
    console.log(`[VALIDATOR] Validation finished for tab ${tabId}. Found ${validFeeds.length} valid feeds.`);
}

// ======================== 主动探测回退 ========================

/**
 * 对给定 origin 尝试常见 feed 路径。当被动扫描（link/a 标签）没找到任何有效 feed 时触发。
 * 使用并发 HEAD + GET，带 feed Accept 头解决 content negotiation。
 * 成功的 URL 立即加入 validFeeds 数组。
 *
 * @param {string} origin        当前页面的 origin（https://example.com）
 * @param {number} tabId         标签页 ID
 * @param {Array}  existingCands 已经尝试过的候选 URL（跳过重复）
 * @param {string} feedAccept    Accept 头值
 * @returns {Promise<Array>}     找到的有效 feed 数组
 */
async function probeFeedPaths(origin, tabId, existingCands, feedAccept) {
    const probePaths = [
        '/feed', '/feed/', '/feed.xml', '/feed.atom', '/feed.json',
        '/rss', '/rss/', '/rss.xml', '/rss.atom', '/rss.json',
        '/atom', '/atom/', '/atom.xml', '/index.xml',
        '/feed/rss', '/feed/atom', '/feed/json',
        '/rss/latest', '/feed/latest',
        '/?feed=rss2', '/?feed=atom',
        '/wp-feed.php',
        '/rss/all', '/feed/all'
    ];

    const existingUrls = new Set(existingCands?.map(c => c.url) || []);
    const probedUrls = new Set(); // 本次已探测过的，防止重复
    const found = [];

    // ============ 辅助函数（提前定义，worker 和 dedup 都能用） ============

    // 从 feed XML/JSON 前 4KB 里提取 feed 标题（用于同内容不同路径的去重）
    function extractFeedTitle(content, format) {
        if (!content) return '';
        try {
            let m;
            if (format === 'json-feed' || content.trim().startsWith('{')) {
                m = content.match(/"title"\s*:\s*"([^"]+)"/);
                return m ? m[1] : '';
            }
            // RSS: <channel><title>TEXT</title>  Atom: <feed><title>TEXT</title>
            m = content.match(/<(?:channel|feed)>(?:(?!<\/?(?:channel|feed)[\s>]).)*?<title>([^<]+)<\/title>/is);
            if (m) return m[1].trim();
            // fallback: 任何 <title>...</title>
            m = content.match(/<title>([^<]+)<\/title>/);
            return m ? m[1].trim() : '';
        } catch(e) { return ''; }
    }

    // 规范化 URL 用于对比：小写 host + 去除末尾斜杠（根路径除外）
    function normalizeUrl(url) {
        try {
            const u = new URL(url);
            let path = u.pathname;
            if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
            return 'https://' + u.hostname.toLowerCase() + path + u.search;
        } catch(e) {
            return url.toLowerCase().replace(/\/+$/, '');
        }
    }

    // 构建浏览器风格 headers（worker 和 dedup 共用）
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0';
    function makeBrowserHeaders(url) {
        const urlObj = new URL(url);
        return {
            'Accept': feedAccept + ', text/html;q=0.9, */*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'User-Agent': ua,
            'Origin': urlObj.origin,
            'Referer': urlObj.origin + '/'
        };
    }

    // ============ 探测主逻辑 ============

    // 跳过已知的 feed hosting 域名（它们的 feed 路径不通用）
    const skipHostPatterns = /\.(pinecast|soundcloud|podomatic|podbean|libsyn|buzzsprout|megaphone\.fm|transistor\.fm)/i;
    if (skipHostPatterns.test(origin)) {
        console.log(`[PROBE] Skipping common-path probe for podcast hosting domain: ${origin}`);
        return found;
    }

    const probeStartTime = Date.now();
    console.log(`[PROBE] Starting common-path probe for ${origin} (${probePaths.length} paths)...`);

    // 并发探测，但限制并发数防止被封
    const MAX_CONCURRENT = 5;
    const queue = [...probePaths];

    async function worker() {
        while (queue.length > 0) {
            const path = queue.shift();
            const url = origin + path;
            if (existingUrls.has(url) || probedUrls.has(url)) continue;
            probedUrls.add(url);

            const browserHeaders = makeBrowserHeaders(url);

            try {
                // 3 秒超时，探测要快
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 3000);
                const headResp = await fetch(url, {
                    method: 'HEAD',
                    headers: browserHeaders,
                    signal: controller.signal
                }).catch(err => {
                    console.log(`[PROBE] HEAD error for ${path}: ${err.message}`);
                    return null;
                });
                clearTimeout(timeoutId);

                let headOk = headResp && headResp.ok;
                const headCt = headResp ? headResp.headers.get('content-type') || '' : '';

                if (headResp) {
                    // 403/405 (Forbidden / Method Not Allowed) — 服务器拒 HEAD 但 GET 可能正常
                    if (headResp.status === 403 || headResp.status === 405) {
                        console.log(`[PROBE] HEAD ${headResp.status} for ${path} — fallback to GET`);
                        headOk = false; // 走 GET 链路
                    } else if (headResp.status >= 400) {
                        console.log(`[PROBE] HEAD ${headResp.status} for ${path}`);
                        continue; // 其他 4xx/5xx 直接放弃
                    }
                }

                // HEAD 成功且 content-type 是 feed → 直接接受
                if (headOk && isFeedContentType(headCt)) {
                    const finalUrl = headResp.url; // 跟随重定向后的最终 URL
                    const ctLower = headCt.toLowerCase();
                    const format = ctLower.includes('atom') ? 'atom' : 
                                   ctLower.includes('json') ? 'json-feed' : 'rss';
                    console.log(`[PROBE] HIT (HEAD content-type): ${url} → ${finalUrl} (ct=${headCt})`);
                    found.push({
                        name: origin.replace(/^https?:\/\//, '') + path,
                        url: finalUrl,
                        finalUrl,
                        faviconURL: `https://www.google.com/s2/favicons?domain=${new URL(finalUrl).hostname}`,
                        format  // 有 format，但还没 content — phase 2 会补
                    });
                    continue;
                }

                // HEAD 不确定 / 403 拒了 HEAD → GET 前 4KB 做内容验证
                try {
                    const { content, finalUrl } = await fetchPartialContent(url, 4096, browserHeaders);
                    if (!content || content.length < 50) continue;
                    const format = detectContentFormat(content);
                    if (format === 'rss' || format === 'atom' || format === 'json-feed' || isLikelyFeedContent(content)) {
                        const title = extractFeedTitle(content, format);
                        console.log(`[PROBE] HIT (content ${format}): ${url} → ${finalUrl}${title ? ' (title: ' + title + ')' : ''}`);
                        found.push({
                            name: origin.replace(/^https?:\/\//, '') + path,
                            url: finalUrl,
                            finalUrl,
                            faviconURL: `https://www.google.com/s2/favicons?domain=${new URL(finalUrl).hostname}`,
                            content, format, title
                        });
                    }
                } catch(e) {
                    // GET 也失败 → 跳过
                }
            } catch(e) {
                // HEAD 失败 → 跳过
            }
        }
    }

    // 启动 workers
    await Promise.all(Array.from({length: MAX_CONCURRENT}, () => worker()));

    // ============ 去重 ============

    // === Phase 1: URL 规范化去重 ===
    const seenNormalized = new Set();
    const phase1 = [];
    for (const item of found) {
        const key = normalizeUrl(item.finalUrl || item.url);
        if (seenNormalized.has(key)) {
            console.log(`[PROBE] Dedup-phase1 (URL): ${item.url} → already covered`);
            continue;
        }
        seenNormalized.add(key);
        phase1.push(item);
    }

    // === Phase 2: 内容去重（同 feed 不同路径，WordPress 典型） ===
    // 对 HEAD 命中但没有 content 的条目，拉一下前 4KB 拿 title
    for (const item of phase1) {
        if (!item.content) {
            try {
                const bh = makeBrowserHeaders(item.url);
                const { content, finalUrl } = await fetchPartialContent(item.url, 4096, bh);
                item.content = content;
                item.finalUrl = finalUrl;
            } catch(e) { /* ignore */ }
        }
        if (!item.format && item.content) {
            item.format = detectContentFormat(item.content);
        }
        if (!item.title && item.content) {
            item.title = extractFeedTitle(item.content, item.format);
        }
    }

    const seenTitleFormat = new Set();
    const deduped = [];
    for (const item of phase1) {
        // 有 title 且 format → 按 (title, format) 去重
        if (item.title && item.format) {
            const key = item.title.toLowerCase().trim() + '|' + item.format;
            if (seenTitleFormat.has(key)) {
                console.log(`[PROBE] Dedup-phase2 (title="${item.title}", ${item.format}): ${item.url} → same as earlier hit`);
                continue;
            }
            seenTitleFormat.add(key);
        }
        // 没 title 的（极端情况）不合并
        // 清理临时字段，不传给 popup
        delete item.content;
        item.finalUrl = undefined; // 已规范化过，不需要
        deduped.push(item);
    }

    console.log(`[PROBE] Probe finished in ${Date.now() - probeStartTime}ms. Found ${found.length} → URL-dedup ${phase1.length} → title-dedup ${deduped.length} unique feeds out of ${probePaths.length} paths.`);
    return deduped;
}

// ======================== 辅助函数 ========================

// 清理旧的 tabFeeds 数据：遍历该标签页之前记录的 feed，
// 在 tabFeedsByURL 里减少 tabCount，归零则删除（防止残留孤儿数据）
function cleanupOldTabFeeds(tabId) {
    const key = "tab_" + tabId;
    if (!window.tabFeeds[key]) return;
    window.tabFeeds[key].forEach(feed => {
        if (window.tabFeedsByURL[feed.url]) {
            window.tabFeedsByURL[feed.url].tabCount--;
            if (window.tabFeedsByURL[feed.url].tabCount <= 0) {
                delete window.tabFeedsByURL[feed.url];
            }
        }
    });
}

// 内容类型检测（严格：只接受明确是 feed 的 MIME，HTML/纯文本/通用 XML 一律排除）
function isFeedContentType(contentType) {
    const normalized = (contentType || '').toLowerCase().split(';')[0].trim();
    if (!normalized) return false; // 缺失 Content-Type → 交给内容验证，不跳过

    // 明确排除的 MIME（HTML、纯文本、通用标记/脚本/样式/图片/字体等）
    // 这些类型绝不可能是 feed，即使内容被服务器错误声明
    const excludedPrefixes = [
        'text/html', 'text/plain', 'text/css', 'text/javascript',
        'application/javascript', 'application/x-javascript',
        'image/', 'font/', 'audio/', 'video/',
        'application/pdf', 'application/zip', 'application/gzip',
        'application/x-www-form-urlencoded', 'multipart/'
    ];
    for (const prefix of excludedPrefixes) {
        if (normalized.startsWith(prefix)) return false;
    }

    // 明确接受的 feed MIME（覆盖标准写法和老服务器的非标写法）
    const feedMimePattern = /^(application\/(rss(\+xml)?|atom(\+xml)?|rdf\+xml|feed\+json|xml\+pcdata)|\.xml|\.rss|\.atom)$/;
    if (feedMimePattern.test(normalized)) return true;

    // 通用 XML/JSON（text/xml 也可能是 HTML 错误声明，但已经被排除前缀拦截）
    if (normalized === 'application/xml' || normalized === 'text/xml') return true;
    if (normalized === 'application/json') return true;

    // 其他未知 MIME → 返回 false，让 GET 内容验证流程处理
    // 这不是"漏判"，而是把判断权交给真正看内容的 detectContentFormat()
    return false;
}

// 获取部分内容
async function fetchPartialContent(url, maxBytes, extraHeaders) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        const fetchOpts = { signal: controller.signal };
        if (extraHeaders) fetchOpts.headers = extraHeaders;
        
        const response = await fetch(url, fetchOpts);
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const reader = response.body.getReader();
        let receivedLength = 0;
        let chunks = [];
        let isDone = false;
        
        while (!isDone && receivedLength < maxBytes) {
            const { done, value } = await reader.read();
            
            if (done) {
                isDone = true;
                break;
            }
            
            chunks.push(value);
            receivedLength += value.length;
        }
        
        // 组合读取的内容
        const contentChunk = new Uint8Array(receivedLength);
        let position = 0;
        for (const chunk of chunks) {
            contentChunk.set(chunk, position);
            position += chunk.length;
        }
        
        // 转换为文本
        const textContent = new TextDecoder().decode(contentChunk);
        return { content: textContent, finalUrl: response.url };
    } catch (e) {
        console.error(`Failed to fetch partial content for ${url}:`, e);
        return { content: "", finalUrl: url };
    }
}

// 内容格式检测
function detectContentFormat(content) {
    if (!content || content.trim() === '') return 'empty';
    
    const normalized = content.trim().toLowerCase();
	// 更宽松的 RSS 检测
	if (/<rss[\s>]/.test(normalized) || 
		(normalized.includes('<channel') && normalized.includes('<item'))) {
		return 'rss';
	}
    
    // 1. 优先检测站点地图
    if (normalized.includes('<sitemapindex') || 
        normalized.includes('<urlset') ||
        normalized.includes('<sitemap>') ||
        normalized.includes('<url>') ||
        normalized.includes('<loc>') ||
        normalized.includes('<lastmod>')) {
        return 'sitemap';
    }
    
    // 2. 检测 JSON Feed
    if (normalized.startsWith('{') || normalized.startsWith('[')) {
        try {
            const json = JSON.parse(content);
            if ((json.version && json.version.startsWith("https://jsonfeed.org/version/")) ||
                (json.items && Array.isArray(json.items))) {
                return 'json-feed';
            }
        } catch {
            // 不是有效 JSON
        }
    }
    
    // 3. 检测 RSS
    if (normalized.includes('<rss') || 
        (normalized.includes('<channel') && normalized.includes('<item'))) {
        return 'rss';
    }
    
    // 4. 检测 Atom
    if (normalized.includes('<feed') || normalized.includes('<entry')) {
        // 检查Atom命名空间
        if (normalized.includes('http://www.w3.org/2005/atom') || 
            (normalized.includes('<id>') && normalized.includes('<updated>'))) {
            return 'atom';
        }
    }
    
    return 'unknown';
}

// 宽松的 Feed 内容检测
// 只统计真正只在 feed 中出现的元素，排除 HTML 和 feed 通用的 <title>/<link>/<description>/<author>/<content>
function isLikelyFeedContent(content) {
    if (!content || content.trim() === '') return false;
    
    const normalized = content.trim().toLowerCase();
    
    // feed 特有的元素（HTML 中不会合法出现）
    const feedSpecificElements = [
        '<rss', '<channel', '<item',
        '<feed', '<entry',
        '<pubdate', '<updated', '<published',
        '<summary', '<guid', '<id>',
        '<lastbuilddate', '<generator', '<language',
        '<category', '<enclosure', '<source>'
    ];

    // 先排除 HTML 页面（<!doctype html> 或 <html 开头）——HTML 页面绝不是 feed
    if (normalized.startsWith('<!doctype html') || normalized.startsWith('<html')) {
        return false;
    }
    
    // feed 特有的元素
    const foundElements = feedSpecificElements.filter(el => normalized.includes(el));
    
    // 必须至少有 2 个 feed 特有元素才认为是有效的
    const isLikely = foundElements.length >= 2;
    
    console.log(`[VALIDATOR] Fallback check for feed: found ${foundElements.length} specific elements - ${foundElements.join(', ')}`);
    
    return isLikely;
}

chrome.runtime.onMessage.addListener(
    function(request, sender, sendResponse) {
        if (request.type === 'validate_feed_candidates') {
            if (sender.tab && sender.tab.id) {
                validateFeedCandidates(request.candidates, sender.tab.id, request.pageUrl);
            }
            return false;
        }
        // MV3 bridge: state snapshot and RPC-style calls from extension pages
        if (request.type === 'rssll_get_state') {
            sendResponse(getBridgeState());
            return true;
        }
        // MV3: tab lifecycle events forwarded by the service worker
        if (request.type === 'rssll_tab_event') {
            if (request.event === 'updated') {
                tabUpdated(request.tabId, {status: 'complete'}, request.tab);
            } else if (request.event === 'removed') {
                tabRemoved(request.tabId);
            }
            return false;
        }
        if (request.type === 'rssll_call') {
            return handleBridgeCall(request, sendResponse);
        }
        // 这里可以保留原始代码中对其他消息类型的处理
        if (request.greeting === "loadedWelcomePage") {
            notifyAction('setPopup', {"popup": "popup.html"});
        }
        return false;
    }
);

/* ===================== MV3 UI bridge (server side) ===================== */

var popupPort = null;
var pendingPopupCloseInfo = null;

chrome.runtime.onConnect.addListener(function(port) {
	if (port.name === 'rssll-popup') {
		popupPort = port;
		popupStateInfo.inPopUp = true;
		port.onDisconnect.addListener(function() {
			popupPort = null;
			popupClosed(pendingPopupCloseInfo);
			pendingPopupCloseInfo = null;
		});
	}
});

function pushToPopup(obj) {
	if (popupPort) {
		try {
			popupPort.postMessage(obj);
		} catch(e) { /* popup disappeared */ }
	}
}

/*
 * Items keep their full description (some feeds embed entire articles via
 * content:encoded).  The popup only ever shows the first ~200 characters in a
 * tooltip, so trimming the copy sent over messaging keeps the state snapshot
 * small - one popup open transfers every item of every feed.
 */
function serializeItems(itemsByGuid) {
	var result = {};
	for (var guid in itemsByGuid) {
		var item = itemsByGuid[guid];
		if (item && typeof item.description === 'string' && item.description.length > 512) {
			var copy = {};
			for (var key in item) {
				copy[key] = item[key];
			}
			copy.description = item.description.substring(0, 512);
			result[guid] = copy;
		} else {
			result[guid] = item;
		}
	}
	return result;
}

function serializeFeed(feed) {
	return {
		name: feed.name,
		url: feed.url,
		feedTitle: feed.feedTitle,
		error: feed.error || null,
		updating: !!feed.updating,
		group: feed.group,
		sortItems: feed.sortItems,
		maxItems: feed.maxItems,
		itemsSize: feed.itemsSize,
		maxItemsSize: feed.maxItemsSize,
		imageSrc: feed.imageSrc || null,
		ttl: feed.ttl,
		updated: (feed.updated instanceof Date) ? feed.updated.getTime() : null,
		expire: (feed.expire instanceof Date) ? feed.expire.getTime() : (feed.expire || 0),
		_seenStates: feed._seenStates,
		_unseenCount: feed._unseenCount,
		_unreadCount: feed._unreadCount,
		data: {
			itemGuids: feed.data.itemGuids,
			itemsByGuid: serializeItems(feed.data.itemsByGuid),
			moreStories: feed.data.moreStories,
			faviconURL: feed.data.faviconURL,
			ttl: feed.data.ttl,
			txtHash: feed.data.txtHash || null,
			pubDate: (feed.data.pubDate instanceof Date) ? feed.data.pubDate.getTime() : null
		}
	};
}

function serializeTabFeeds() {
	var result = {};
	for (var url in window.tabFeedsByURL) {
		var entry = window.tabFeedsByURL[url];
		result[url] = { feed: { name: entry.feed.name, url: entry.feed.url, icon: entry.feed.icon, type: entry.feed.type } };
	}
	return result;
}

function getBridgeState() {
	return {
		options: options,
		feeds: feedInfo.feeds.map(serializeFeed),
		feedsByURL: feedInfo.feedsByURL,
		tabFeedsByURL: serializeTabFeeds(),
		version: manifest.version
	};
}

function withFeed(url, fn) {
	var idx = feedInfo.feedsByURL[url];
	if (idx != undefined) {
		var feed = feedInfo.feeds[idx];
		if (feed) {
			fn(feed);
		}
	}
}

function handleBridgeCall(request, sendResponse) {
	var args = request.args || [];
	switch (request.fn) {
		case 'openExtensionPage':
			openExtensionPage(args[0]);
			return false;
		case 'openInTab':
			// delay=false：fixPopupClosesBug 是 MV2 弹窗的兼容开关，MV3 下
			// 打开标签页不会关闭 popup，无需延迟，立即创建即可。
			openInTab(args[0], args[1], args[2], false,
				args[3] ? function(tab) { if (tab && tab.id != undefined) popupStateInfo.firstTab = tab.id; } : undefined);
			return false;
		case 'popupClosed':
			pendingPopupCloseInfo = args[0];
			popupClosed(args[0]);
			return false;
		case 'checkLocalStorageIntegrity':
			checkLocalStorageIntegrity();
			if (request.needResponse) { sendResponse({result: options}); return true; }
			return false;
		case 'fixGroupIndexing':
			fixGroupIndexing();
			if (request.needResponse) { sendResponse({result: options}); return true; }
			return false;
		case 'updateOptions':
			updateOptions(args[0]);
			sendResponse({result: options});
			return true;
		case 'addSubscriptionFromPopup':
			var newFeed = addSubscriptionFromPopup(args[0], args[1]);
			sendResponse({result: newFeed ? serializeFeed(newFeed) : null});
			return true;
		case 'replaceConfig':
			try {
				replaceConfig(args[0]);
				sendResponse({result: true});
			} catch(e) { sendResponse({error: String(e)}); }
			return true;
		case 'mergeConfig':
			try {
				mergeConfig(args[0]);
				sendResponse({result: true});
			} catch(e) { sendResponse({error: String(e)}); }
			return true;
		case 'getConfigJSON':
			sendResponse({result: getConfigJSON()});
			return true;
		case 'logMsg':
			logMsg(args[0]);
			return false;
		case 'loadFeed':
			withFeed(args[0], function(feed) { feed.loadFeed(args[1]); });
			return false;
		case 'resetFeedUpdating':
			withFeed(args[0], function(feed) { feed.updating = false; });
			return false;
		case 'setSeen':
		case 'setRead':
		case 'unsetRead':
			withFeed(args[0], function(feed) { feed[request.fn](args[1]); });
			return false;
		case 'reconcileTabFeeds':
			// popup 打开时的兜底清理：无论竞态还是消息丢失导致的残留，
			// 都按活跃标签页列表清除 tabFeeds 中的孤儿条目。
			var activeIds = {};
			(args[0] || []).forEach(function(id) { activeIds["tab_" + id] = true; });
			var reconciled = false;
			for (var key in window.tabFeeds) {
				if (!activeIds[key]) {
					removeTabFeeds(parseInt(key.substring(4)));
					reconciled = true;
				}
			}
			if (reconciled) {
				checkBrowserIcon();
				pushToPopup({type: 'rssll_event', event: 'tabFeedsSync', tabFeedsByURL: serializeTabFeeds()});
			}
			return false;
	}
	return false;
}

/* =================== end MV3 UI bridge (server side) =================== */

// **修改**: 原 tabrss.js 中的逻辑现在需要在这里实现
function tabUpdated(tabId, info, tab) {
	if (info.status == "complete") {
		removeTabFeeds(tabId); // 重新加载：只清理旧数据，标签还活着，不能标为已关闭
		addTabDetails(tab);  // 再添加新的
	}
}

// 纯数据清理：移除某标签页探测到的全部候选源
function removeTabFeeds(tabId) {
	var closedId = "tab_" + tabId;
	var closedTabFeeds = window.tabFeeds[closedId];
	if (closedTabFeeds)	{
		for (var i = 0, len = closedTabFeeds.length; i < len; ++i) {
			var feed = closedTabFeeds[i];
			var tabsForURL = window.tabFeedsByURL[feed.url];
            if(tabsForURL) {
			    tabsForURL.tabCount--;
			    if (tabsForURL.tabCount <= 0) {
				    delete window.tabFeedsByURL[feed.url];
			    }
            }
		}
		delete window.tabFeeds[closedId];
	}
}

// 标签页真正关闭（onRemoved）：标记 + 清理 + 通知
function tabRemoved(tabId) {
	// 标记为已关闭：若有异步验证仍在进行中，完成时会检查此标记并丢弃结果。
	// 60 秒后自动移除标记（验证最长耗时有限，防止集合无限增长）。
	closedTabs.add(tabId);
	setTimeout(function() { closedTabs.delete(tabId); }, 60000);
	removeTabFeeds(tabId);
	checkBrowserIcon();
	pushToPopup({type: 'rssll_event', event: 'tabFeedsSync', tabFeedsByURL: serializeTabFeeds()});
}

function addTabDetails(tab) {
	if (tab.url && (tab.url.startsWith("http://") || tab.url.startsWith("https://"))) {
		getTabRSS(tab.id);
	}
}

function getTabRSS(tabId) {
    // 现在 executeScript 的作用就是触发 findrss.js 去发送候选列表
    // MV3: 脚本注入由 service worker 执行（offscreen 无法访问 chrome.scripting）
	chrome.runtime.sendMessage({type: 'rssll_ui', cmd: 'executeScript', tabId: tabId}, function() {
		if (chrome.runtime.lastError) {
			// tab 可能已关闭，忽略
		}
	});
}

function addAllTabs(tabs) {
	for (var i = 0, len = tabs.length; i < len; ++i) {
		addTabDetails(tabs[i]);
	}       
}

function initExtensionFS() {
    if(window.webkitRequestFileSystem) {
        window.webkitRequestFileSystem(window.TEMPORARY, 1024 *1024, 
            function (fs) {
                console.log('Opened file system: ' + fs.name);
                extensionFS = fs;
            },
            function failFS(e) {
                console.error('Failed to open file system: ' + e);
            }
        );
    }
}

function popupClosed(closedInfo) {

	if (!popupStateInfo.inPopUp) {
		// Already cleaned up (e.g. via port disconnect)
		return;
	}
	popupStateInfo.inPopUp = false;

	openDelayedTabs();

	if (popupStateInfo.firstTab != undefined) {
		chrome.runtime.sendMessage({type: 'rssll_ui', cmd: 'activateTab', tabId: popupStateInfo.firstTab}, function() {
			void chrome.runtime.lastError;
		});
	}
	popupStateInfo.firstTab = undefined;

	if (closedInfo && closedInfo.feedUrl && closedInfo.seenGuids) {
		withFeed(closedInfo.feedUrl, function(feed) {
			closedInfo.seenGuids.forEach(function(guid) {
				feed.setSeen(guid);
			});
		});
	}
	updateSeenStates();
	setButtonTitle(unseenFeedCount, errorFeedCount);
}

function openDelayedTabs() {

	var lim = delayedTabs.length;
	for (var i = 0; i < lim; ++i) {
		var newTab = delayedTabs[i];
		if (i == 0) {
			newTab.active = true;
			openInTab(newTab.url, true, false, false, function(tab) {
				popupStateInfo.firstTab = tab.id;
			});
		} else {
			openInTab(newTab.url, false);
		}
	}
	delayedTabs = [];
}

function updateSeenStates() {
	seenStates = {};
	feedInfo.feeds.forEach(function(feed) {
		seenStates[feed.url] = feed.getSeenStates();
	});
	saveSeenStates();
}

/*
 * This function is a work-around for the "disappearing feeds" issue
 * in Chrome versions where extension storage is deleted when browser
 * history is deleted.
 */
function checkLocalStorageIntegrity() {
	var lastVersion = localStorage["version"];
	if (!lastVersion) {
		console.warn("Extension local storage has been deleted. Rebuilding");
		cleanLocalStorage();
	}
}

function saveToLocalStorage(key, data) {
	try {
		localStorage[key] = data;
	} catch(e) { 
		console.error("Local storage update failed for \"" + key + "\": " + e); 
	}
}

function saveSeenStates() {
	saveToLocalStorage("seenStates", JSON.stringify(seenStates));
}

function fixGroupIndexing() {
	var groupArray = [];
	var newGroups = {};
	for (var groupName in options.groups)
	{
		var idx = options.groups[groupName];
		groupArray[idx] = groupName;
	}

	var nextIdx = 0;
	var warned = false;
	for (var i = 0, len = groupArray.length; i < len; ++i) {
		if (!groupArray[i]) {
			if (!warned) {
				console.warn("Group indexes have been corrupted - recalculating");
				warned = true;
			}
		} else {
			newGroups[groupArray[i]] = nextIdx++;
		}
	}

	if (warned) {
		options.groups = newGroups;
	}

	//END HACK
}

function saveBookmarkFolderIds() {
	for (var i = 0, len = options.subscriptions.length; i < len; ++i) {
		var sub = options.subscriptions[i];
		if (feedInfo.feedsByURL[sub.url] != undefined) {
			var feed = feedInfo.feeds[feedInfo.feedsByURL[sub.url]];
			if (feed) {
				sub.useBookmarkFolder = feed.useBookmarkFolder;
			}
		}
	}
}

function saveOptions() {
	fixGroupIndexing();
	saveBookmarkFolderIds();
	saveToLocalStorage("options", JSON.stringify(options));
}

function getManifest() {
	manifest = chrome.runtime.getManifest();
	checkVersion();
}

function checkVersion() {
	var lastVersion = localStorage["version"];
	if (lastVersion != manifest.version) {
		saveToLocalStorage("version", manifest.version);
		versionChanged = true;
		notifyAction('setPopup', {"popup": "updated.html"});
	}
}

function loadOptions() {
	var optionsJSON = localStorage["options"];
	if (optionsJSON) {
        try {
            var storedOptions = JSON.parse(optionsJSON);
            Object.assign(options, storedOptions); 
            if (storedOptions.longFormat) { options.popupHeight = 800; delete options.longFormat; }
            if (storedOptions.delayTabOpen) { delete options.delayTabOpen; }
            if (storedOptions.saveFeedXML) { delete options.saveFeedXML; }

        } catch(e) {
            console.error("Failed to parse options, using defaults.", e);
        }
	}
}

function loadAndSetSeenStates() {
	var mySeenStatesJSON = localStorage["seenStates"];
	if (mySeenStatesJSON) {
        try {
		    seenStates = JSON.parse(mySeenStatesJSON);
        } catch(e) {
            seenStates = {}; 
        }
	}
	feedInfo.feeds.forEach(initializeFeed);
	saveSeenStates();
	setButtonTitle(unseenFeedCount, errorFeedCount);
}

function initializeFeed(feed) {
	var oldFeedTxt = localStorage["feed:" + feed.url];
	if (oldFeedTxt) {
		var parser=new DOMParser();
		var xmlDoc=parser.parseFromString(oldFeedTxt,"text/xml");
		feed.populate(xmlDoc, oldFeedTxt, true);
	}
	var feedSeenStates = seenStates[feed.url];
	if (feedSeenStates) {
		for (var guid in feedSeenStates) {
			feed.setSeenStateByGuid(guid, feedSeenStates[guid]);
		}
	}
	if (feed.hasUnseen()) {
		unseenFeedCount++;
	}
	feed.unseenStateCallback = feedUnseenStateCallback;
	feed.errorStateCallback = feedErrorStateCallback;
	feed.updateCallback = feedUpdateCallback;
	seenStates[feed.url] = feed.getSeenStates();
}

function loadSavedState() {
	loadOptions();
	buildFeedInfo();
	loadAndSetSeenStates();
	//if (versionChanged) {
		cleanLocalStorage();
	//}
}

function changeMaxConcurrentRequests(num) {
	if (num == undefined) {
		num = options.unlimitedRequests ? feedInfo.feeds.length : options.maxConcurrentRequests;
	}
	if (xmlHttpRequestManager) {
		xmlHttpRequestManager.setMaxRunning(num);
	}
}

function cleanLocalStorage() {
	try {
		localStorage.clear();
		saveAllLocalStorage();
	} catch(e) { console.error("Local storage clean failed: " + e); }
}

function saveAllLocalStorage() {
	saveToLocalStorage("version", manifest.version);
	saveOptions();
	saveSeenStates();
	saveFolderIds();
	//feedInfo.feeds.forEach(saveFeedText);
}

function getConfigJSON() {
	var config = {};
	config.id = "RSS Live Links";
	config.version = manifest.version;
	config.options = options;
	config.seenStates = seenStates;
	return JSON.stringify(config);
}

function replaceConfig(configJSON) {
	var myOptions = {};
	myOptions.subscriptions = [];
	myOptions.groups = {};
	var newConfig = JSON.parse(configJSON);
	var id = newConfig.id
	// MV3: offscreen 中 chrome.i18n 不可用，使用固定文本
	if (id != "RSS Live Links") {
		throw new Error("Invalid configuration file");
	}
	if (newConfig.options) {
		for (var key in newConfig.options) {
			myOptions[key] = newConfig.options[key];
		}
	} 
	saveOptions();

	seenStates = newConfig.seenStates;
	if (seenStates) {
		saveSeenStates()
	} else {
		seenStates = {};
		try {
			delete localStorage["seenStates"];
		} catch(e) { console.error("Local storage seenState deletion failed: " + e); }
	}
	updateOptions(myOptions);
}

function mergeConfig(configJSON) {
	var newConfig = JSON.parse(configJSON);
	var id = newConfig.id
	if (id != "RSS Live Links") {
		throw new Error("Invalid configuration file");
	}
	var mods = false
	var myOptions = {};
	myOptions.subscriptions = [];
	myOptions.groups = {};
	options.subscriptions.forEach( function(feed) {
		myOptions.subscriptions.push(feed);
	});
	if (newConfig.options && newConfig.options.subscriptions) {
		newConfig.options.subscriptions.forEach( function(feed) {
			if (feedInfo.feedsByURL[feed.url] == undefined) {
				myOptions.subscriptions.push(feed);
				mods = true;
			}
		});
	}

	if (newConfig.seenStates) {
		for (var url in newConfig.seenStates) {
			if (seenStates[url] == undefined) {
				seenStates[url] =  newConfig.seenStates[url];
			}
		}
		saveSeenStates();
	}
	if (mods) {
		updateOptions(myOptions);
	}
}

function updateOptions(newOptions) {
	checkLocalStorageIntegrity();
	var mods = false;
	var doClean = false;
	var doBuildFeeds = false;
	var workerMods = false;
	var subMods = {additions: false, deletions: false};

	for(var key in newOptions) {
		if (key == "maxItems" || key == "unlimitedItems" || key == "defaultTtl") {
			if (options[key] != newOptions[key]) {
				options[key] = newOptions[key];
				mods = true;
			}
		} else if (key == "useAvailableIcon" || key == "maintainBadge") {
			if (options[key] != newOptions[key]) {
				options[key] = newOptions[key];
				checkBrowserIcon((key == "maintainBadge"));
			}
		} else if (key == "saveFeedXML") {
		} else if (key == "useWebWorker") {
			if (options[key] != newOptions[key]) {
				options[key] = newOptions[key];
				workerMods = true;
			}
		} else if (key == "subscriptions") {
			options.subscriptions = newOptions.subscriptions;
			doBuildFeeds = true;
		} else { 
			options[key] = newOptions[key];
		}
	}

	if (workerMods) {
		setWorkerStrategy();
	}

/*	if (doClean) {
		cleanLocalStorage();
	} */

	if (mods) {
		feedInfo.feeds.forEach(function(feed) {
			feed.setDefaultTtl(options.defaultTtl);
			feed.setMaxItems(options.unlimitedItems ? -1 : options.maxItems);
		});
	}

	if (doBuildFeeds) {
		subMods = buildFeedInfo();
		checkBrowserIcon();
	}

	if (mods || subMods.additions || subMods.deletions) {
		if (subMods.additions) {
			updateFeeds();
		} else {
			saveSeenStates();
		}
	}
	saveOptions();
	changeMaxConcurrentRequests();
}

function createNewFeed(data) {
	var newFeed = new Feed(data.name, 
			               data.url, 
						   (options.unlimitedItems ? -1 : options.maxItems),
						   (data.refreshTime ? data.refreshTime :"TTL"),
						   options.defaultTtl, data.faviconURL);
	newFeed.group = data.group;
	newFeed.autoopenNew = data.autoopenNew;
	newFeed.sortItems = data.sortItems ? data.sortItems : 0;
	newFeed.changesUnseen = (data.changesUnseen == true);
	newFeed.networkTimeout = (data.networkTimeout ? data.networkTimeout : 0);
	var flag = (data.useBookmarkFolder == undefined ? (hasBookmarkFolder(data) ? true : false ) : data.useBookmarkFolder);
	newFeed.useBookmarkFolder = flag;
	var feedSeenStates = seenStates[newFeed.url];
	if (feedSeenStates) {
		for (var guid in feedSeenStates) {
			newFeed.setSeenStateByGuid(guid, feedSeenStates[guid]);
		}
	}
	if (loaded) {	
		newFeed.unseenStateCallback = feedUnseenStateCallback;
		newFeed.errorStateCallback = feedErrorStateCallback;
		newFeed.updateCallback = feedUpdateCallback;
		seenStates[newFeed.url] = newFeed.getSeenStates();
	}
	return newFeed;
}

function addSubscriptionFromPopup(subscriptionData, doLoad) {
	if (feedInfo.feedsByURL[subscriptionData.url]) {
		return;
	}
	options.subscriptions.push(subscriptionData);
	var newFeed = createNewFeed(subscriptionData);
	feedInfo.feedsByURL[newFeed.url] = feedInfo.feeds.length;
	feedInfo.feeds.push(newFeed);
	if (loaded) {
		changeMaxConcurrentRequests();
		if (subscriptionData.useBookmarkFolder) {

			var func = (doLoad ? 
				function (feed, folder) {
					saveOptions();
					feed.loadFeed(options.defaultTimeout);
				} : function (feed, folder) {saveOptions();});

			createBookmarkFolder(newFeed, func);
		} else {
			saveOptions();
		   	if (doLoad) {
				newFeed.loadFeed(options.defaultTimeout);
			}
		}
	}
	checkBrowserIcon();
	return newFeed;
}

function feedUpdateCallback(feed, isUpdated) {
	if (feed.autoopenNew && feed.hasUnseen()) {
		console.log("Auto opening " + feed.name);
		feed.getItems().forEach(function(item) {
			var guid = item.guid;
			if (!feed.isSeen(guid)) {
				console.log("Auto opening " + item.url);
				openInTab(item.url, false, true);
				feed.setSeen(guid);
			}
		});
	}

	if (feed.error) {
		console.error(feed.name + " has an error: " + feed.error);
	} else if (isUpdated) {
		//saveFeedText(feed);
		if (feed.hasUnseen()) {
			console.log(feed.name + " has unseen updates");
		}
		if (hasBookmarkFolder(feed)) {
			updateBookmarkFolder(feed);
		}
	}
	// MV3: notify an open popup so it can refresh this feed's display
	pushToPopup({type: 'rssll_event', event: 'feedSync', feed: serializeFeed(feed), isUpdated: !!isUpdated});
}

function feedUnseenStateCallback(feed) {
	if (feed.hasUnseen()) {
		unseenFeedCount++;
	} else {
		unseenFeedCount--;
	}
	setButtonTitle(unseenFeedCount, errorFeedCount);
	pushToPopup({type: 'rssll_event', event: 'feedSync', feed: serializeFeed(feed), isUpdated: false});
}

function feedErrorStateCallback(feed) {
	if (feed.error) {
		errorFeedCount++;
	} else {
		errorFeedCount--;
	}
	setButtonTitle(unseenFeedCount, errorFeedCount);
	pushToPopup({type: 'rssll_event', event: 'feedSync', feed: serializeFeed(feed), isUpdated: false});
}

function buildFeedInfo() {
	var myFeeds = [];
	var myFeedsByURL = {};

	options.subscriptions.forEach(function(myFeed) {
		if (myFeed.url && myFeed.name) {
			myFeedsByURL[myFeed.url] = myFeeds.length;
			myFeeds.push(myFeed);
		}
	});

	/*
	 * Now see if we already have some of these feeds, and if so
	 * replace the new info with that info at the new position.
	 */
	var adds = false;
	for(var url in myFeedsByURL) {
		var myFeedIndex = myFeedsByURL[url];
		var myFeed = myFeeds[myFeedIndex];

		if (feedInfo.feedsByURL[url] != undefined) {
			var feedIndex = feedInfo.feedsByURL[url];
			var oldFeed = feedInfo.feeds[feedIndex];
			if (myFeed.refreshTime && oldFeed.refreshTime != myFeed.refreshTime) {
				oldFeed.setRefreshTime(myFeed.refreshTime);
			}
			if (myFeed.networkTimeout && oldFeed.networkTimeout != myFeed.networkTimeout) {
				oldFeed.networkTimeout = myFeed.networkTimeout;
			}
			if (oldFeed.name != myFeed.name) {
				renameBookmarkFolder(oldFeed, myFeed.name);
				oldFeed.name = myFeed.name; 
			}
			oldFeed.group = myFeed.group;
			oldFeed.sortItems = myFeed.sortItems ? myFeed.sortItems : 0;
			var flag = (myFeed.useBookmarkFolder == undefined ? (hasBookmarkFolder(myFeed) ? true : false ) : myFeed.useBookmarkFolder);
			oldFeed.useBookmarkFolder = flag;

			myFeeds[myFeedIndex] = oldFeed;
			delete feedInfo.feedsByURL[url];
		} else {
			adds = true;
			myFeeds[myFeedIndex] = createNewFeed(myFeed);
		}
	}

	var dels = false;
	for (var url in feedInfo.feedsByURL) {
		var deletedFeed = feedInfo.feeds[feedInfo.feedsByURL[url]];
		deletedFeed.unseenStateCallback = undefined;
		deletedFeed.errorStateCallback = undefined;
		deletedFeed.updateCallback = undefined;
		if (deletedFeed.hasUnseen()) {
			unseenFeedCount--;
		}
		if (deletedFeed.error) {
			errorFeedCount--;
		}
		try {
			delete seenStates[url];
		} catch(e) { console.error("Local storage seenState deletion failed: " + e); }
		try {
			delete localStorage["feed:" + url];
		} catch(e) { console.error("Local storage feed URL deletion failed for feed:" + url + ": " + e); }
		deleteBookmarkFolder(deletedFeed);
		dels = true;
	}

	if (loaded && (adds || dels)) {
		changeMaxConcurrentRequests();
		saveSeenStates();
		setButtonTitle(unseenFeedCount, errorFeedCount);
	}

	if (loaded) {
		applyBookmarkFolderChanges(myFeeds);
	}

	feedInfo.feeds = myFeeds;
	feedInfo.feedsByURL = myFeedsByURL;
	return {additions: adds, deletions: dels};
}

function applyBookmarkFolderChanges(myFeeds) {
	var count = myFeeds.length;
	var doneFunction = function (feed, folder) {
		if (feed && feed.useBookmarkFolder && folder) {
			loadBookmarkFolder(feed, folder);
		}
		if (--count <= 0) {
			saveOptions();
		}
	};

	var savedCount = count;
	for (var i = 0; i < savedCount; ++i) {
		var feed = myFeeds[i];
		if (feed.useBookmarkFolder && !hasBookmarkFolder(feed)) {
			createBookmarkFolder(feed, doneFunction);
		} else if (hasBookmarkFolder(feed) && !feed.useBookmarkFolder) { 
			deleteBookmarkFolder(feed, doneFunction);
		} else {
			if (--count <= 0) {
				saveOptions();
			}
		}
	}
}

function autoUpdateFeeds() {
	checkLocalStorageIntegrity();
	if (!noAutoUpdates) {
		try {
			updateFeeds();
		} catch (e) {
			console.error("Feed update cycle failed: " + e);
		}
		window.setTimeout(autoUpdateFeeds, 30000);
	}
}

function updateFeeds() {
	var feeds = feedInfo.feeds;
	var now = new Date();
	for (var i = 0; i < feeds.length; ++i) {
		var feed = feeds[i];
		if (!feed.updating && (!feed.expire || feed.expire.getTime() < now.getTime())) {
			console.warn("Fetching feed \"" + feed.name + "\"");
			feed.loadFeed(options.defaultTimeout);
		}
	}
}

function openExtensionPage(page, focus, win) {
	if (focus == undefined)
	{
		focus = true;
	}
	var URL = chrome.runtime.getURL(page);
	if (win) {
		win.location = URL;
	} else {
		openInTab(URL, focus);
	}
}

function openInTab(url, focus, reuseTab, delay, callback) {
	/*
	 * MV3: offscreen 文档不能操作标签页（chrome.tabs.create 静默无效），
	 * 整个开标签逻辑（含同 URL 查重）转发给 service worker 执行。
	 * fixPopupClosesBug 是 MV2 弹窗兼容开关，MV3 下不再需要延迟创建。
	 */
	chrome.runtime.sendMessage(
		{type: 'rssll_ui', cmd: 'openInTab', url: url, focus: !!focus},
		function(resp) {
			void chrome.runtime.lastError;
			if (callback && resp && resp.tab) {
				callback(resp.tab);
			}
		}
	);
}

function updateButtonTitle() {
	var errors = 0;
	var updates = 0;
	feedInfo.feeds.forEach(function(feed) {
		if (feed.error) {
			errors++;
		} else if (feed.hasUnseen()) {
			updates++
		}
	});
	if (errors != badgeErrors || updates != badgeCount) {
		setButtonTitle(updates, errors);
	}
}

var badgeCount = 0;
var badgeErrors = 0;
var badgeText = "";
var animatedIconPath = "img/rssll_19x19.png";

/*
 * MV3: chrome.action 调用在 offscreen 文档中不会生效（浏览器 UI 归 service
 * worker 管），统一转发给 service worker 执行。
 */
function notifyAction(method, details, callback) {
	try {
		chrome.runtime.sendMessage({type: 'rssll_action', method: method, details: details}, function() {
			var err = chrome.runtime.lastError;
			if (err) {
				console.error("action notify '" + method + "' failed: " + err.message);
			}
			if (callback) callback();
		});
	} catch (e) {
		console.error("Failed to notify action '" + method + "': " + e);
	}
}

/**
 * 更新浏览器动作图标、徽章和工具提示。
 * (样式优化): 将原生徽章的背景颜色修改为橙黄色。
 */
function setButtonTitle(upds, errors) {
	if (upds < 0)
		upds = 0;
	if (errors < 0)
		errors = 0;
	
	var doBoing = (badgeCount < upds);
	var goingToNonZero =(badgeCount <= 0 && upds != 0);
	var goingToZero =(badgeCount > 0 && upds == 0);
	
	badgeCount = upds;
	badgeErrors = errors;

	var badgeText = "";
	if (options.maintainBadge) {
		if (upds > 99) { // 增加一个上限，防止文本过长
			badgeText = "99+";
		} else if (upds > 0) {
			badgeText = "" + upds;
		} else if (errors > 0) {
			badgeText = "!";
		} else {
			badgeText = "";
		}
	}

	if (goingToZero) {
		stopAnimateLoop();
	}
	if (goingToNonZero || animatedIconPath != gfx.src) {
		animatedIconPath = gfx.src;
		animFrameCache = {}; // 图标换了，缓存帧作废
		if (badgeCount > 0)
			startAnimate();
		else
			stopAnimate();
	}

	if (options.maintainBadge) {
        // **核心修改：在这里改变颜色值**
        // 错误时使用深橙色 [R:242, G:139, B:40]
        // 更新时使用亮橙黄色 [R:255, G:191, B:0]
		var backGndClr = (errors > 0 && upds === 0) ? [242, 139, 40, 255] : [255, 191, 0, 255];
		notifyAction('setBadgeBackgroundColor', {color: backGndClr});
	}
	notifyAction('setBadgeText', {text: badgeText});

	// MV3: offscreen 文档中 chrome.i18n 不可用，标题文本由 service worker
	// 用 updates/errors 数字自行拼接，这里只传数据。
	notifyAction('setTitle', {updates: upds, errors: errors});
}

/*
 * Another rip-off alert - this is ALL from GMail Checker Plus!
 */

var canvasContext;
var rotation = 1;
var factor = 1;
var animTimer;
var loopTimer;
var animDelay = 33; // ~30fps：19px 小图肉眼无差别，消息量降到原来的 1/3
var animFrameCache = {}; // 旋转角度 -> dataURL，避免每帧重复 PNG 编码
var lastAnimFrame = null;

function initGraphics() {
	canvasContext = canvas.getContext('2d');
}

function startAnimate() {
  stopAnimateLoop();
    
  if(options.animateButton) {
    animTimer = setInterval(doAnimate, animDelay);
    setTimeout(stopAnimate, 2000);
    loopTimer = setTimeout(startAnimate, 20000);
  } else {
	stopAnimate();
  }
}

function stopAnimate() {
  if(animTimer != null)
    clearInterval(animTimer);
  animTimer = null;

  notifyAction('setIcon', {path:gfx.src});

  rotation = 1;
  factor = 1;
  lastAnimFrame = null;
}

function stopAnimateLoop() {
  if(loopTimer != null)
    clearTimeout(loopTimer);
    
  stopAnimate();
}

function doAnimate() {
  var frameRotation = rotation;
  canvasContext.save();
  canvasContext.clearRect(0, 0, canvas.width, canvas.height);
  canvasContext.translate(
   Math.ceil(canvas.width/2),
   Math.ceil(canvas.height/2));
  canvasContext.rotate(frameRotation*2*Math.PI);
  canvasContext.drawImage(gfx,
   -Math.ceil(canvas.width/2),
   -Math.ceil(canvas.height/2));
  canvasContext.restore();
  
  rotation += 0.01 * factor;
  
  if(rotation <= 0.9 && factor < 0)
    factor = 1;
  else if(rotation >= 1.1 && factor > 0)
    factor = -1;        
    
  /*
   * ImageData 无法通过 JSON 消息传递，只能转成 dataURL 交给 service worker 还原。
   * 振荡动画只会出现 0.90~1.10、步进 0.01 的约 21 个角度，缓存后只有首轮
   * 需要真正做 PNG 编码，不必每帧重复。
   */
  var cacheKey = frameRotation.toFixed(2);
  var dataUrl = animFrameCache[cacheKey];
  if (!dataUrl) {
    dataUrl = canvas.toDataURL();
    animFrameCache[cacheKey] = dataUrl;
  }
  if (dataUrl !== lastAnimFrame) {
    lastAnimFrame = dataUrl;
    notifyAction('setIconImageData', {dataUrl: dataUrl});
  }
}

var nextPlay = 0;

function setWorkerStrategy() {

	if (options.useWebWorker) {
		if (!rssllWebWorker) {
			try {
				rssllWebWorker = new WebWorker();
			} catch (e) {
				console.error("Failed to create WebWorker, falling back to direct requests: " + e);
			}
		}
		if (rssllWebWorker) {
			xmlHttpRequestManager = undefined;
			return;
		}
	}
	if (!xmlHttpRequestManager) {
		xmlHttpRequestManager = new XMLHttpRequestManager();
	}
	if (rssllWebWorker) {
		rssllWebWorker.terminate();
		rssllWebWorker = undefined;
	}
}

function logMsg(msg) {
	console.log(msg);
}

function getContextMenuItem(type, item) {
	var ctxItem = null;
	var ctxType = contextMenus[type];
	if (ctxType) {
		ctxItem = ctxType[item];
	}
	return ctxItem;
}

function clearRssCache() {
    const now = Date.now();
    let resetCount = 0;
    feedInfo.feeds.forEach(feed => {
        let isStuck = false;

        // 条件1：updating 长时间未完成（超过1分钟）
        if (feed.updating && feed.updated && now - feed.updated.getTime() > 1 * 60 * 1000) {
            isStuck = true;
        }

        // 条件2：有错误信息，说明上次更新失败
        if (feed.error) {
            isStuck = true;
        }

        // 条件3：expire 设得太远但实际没更新（可能服务器一直304）
        if (feed.expire && feed.expire.getTime() - now > 60 * 60 * 1000) {
            isStuck = true;
        }

        // 条件4：72小时未更新（加null判断）
        if (!feed.updated || now - feed.updated.getTime() > 72 * 60 * 60 * 1000) {
            isStuck = true;
        }

        if (isStuck) {
            feed.setError(null);                 // 清除错误状态
            feed.expire = new Date(0);           // 强制过期
            feed.updating = false;               // 解锁更新状态
            if (feed.data) {
                delete feed.data.txtHash;
                delete feed.data.moreStories;
            }

            console.warn(`[重置] 卡住的订阅：${feed.name} (${feed.url})`);
            resetCount++;
            try {
                feed.loadFeed(options.defaultTimeout);
                console.log(`[更新] 已重新加载：${feed.name}`);
            } catch (e) {
                console.error(`[失败] ${feed.name} 加载失败：`, e);
            }
        }
    });

    console.log(`[重置完成] 共 ${resetCount} 个订阅被清理并重载`);

    // probeCache 定期清理：剔除过期条目 + 硬上限淘汰最旧条目
    // offscreen 文档永不卸载，必须主动回收，否则每访问一个新 origin 就永久留一条
    let evicted = 0;
    const sweepNow = Date.now();
    // 先按 TTL 剔除过期条目
    for (const [origin, entry] of probeCache) {
        if ((sweepNow - entry.timestamp) >= PROBE_CACHE_TTL) {
            probeCache.delete(origin);
            evicted++;
        }
    }
    // 再按硬上限淘汰最旧的条目
    if (probeCache.size > PROBE_CACHE_MAX) {
        const sorted = [...probeCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
        const excess = sorted.length - PROBE_CACHE_MAX;
        for (let i = 0; i < excess; i++) {
            probeCache.delete(sorted[i][0]);
            evicted++;
        }
    }
    if (evicted > 0) {
        console.log(`[probeCache] 清理 ${evicted} 条，当前 ${probeCache.size} 条`);
    }
}

