/**
 * RSS Live Links MV3 - feed detector content script.
 *
 *    This file is part of RSS Live Links (LGPL-3.0, see LICENSE and COPYING).
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
 * Substantially modified 2026-10-28 by rzhy1: rewritten feed detection
 * (content-type checks, HTML rejection, stricter link/path matching) and
 * reporting of pages without candidates so the background can probe common
 * feed paths. See NOTICE.
 */

(function() {
    if (window.top !== window.self) return;
    // 去重：service worker 每次唤醒都会 reinject，必须在注册任何监听器之前返回，
    // 否则 pageshow/load 监听器会无限累积。
    if (window.rssFinderInitialized) return;
    window.rssFinderInitialized = true;
    
    // BFCache 处理：页面从往返缓存恢复时重置标记，以便下次注入重新检测
    const resetState = () => window.rssFinderInitialized = false;
    window.addEventListener('pageshow', resetState);
    window.addEventListener('load', resetState);
    
    const DEBUG = true;
    const log = (...args) => DEBUG && console.log('[RSS-FINDER]', ...args);
    
    // 发送检测结果（总是发，即使没有候选 —— 后台需要知道当前页面以便主动探测）
    const sendCandidates = links => {
        try {
            chrome.runtime.sendMessage({
                type: 'validate_feed_candidates',
                candidates: links || [],
                pageUrl: location.href,
                tabId: chrome.devtools?.inspectedWindow?.tabId || null
            });
        } catch (e) {
            console.error("[RSS-FINDER] Send error", e);
        }
    };
    
    // 增强的内容检测工具函数 - 修复CDATA和格式问题
    const extractTitle = (content, isXml = true) => {
        try {
            if (isXml) {
                // 更强大的正则表达式，处理CDATA和格式变化
                const titleMatch = content.match(
                    /<(?:channel|feed)[^>]*>[\s\S]*?<title(?:\s+[^>]*)?>([\s\S]*?)<\/title>/is
                );
                
                if (titleMatch && titleMatch[1]) {
                    // 处理CDATA内容
                    let titleText = titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '');
                    
                    // 移除HTML标签
                    titleText = titleText.replace(/<[^>]+>/g, '');
                    
                    // 修剪空白字符
                    return titleText.trim();
                }
            } else {
                const jsonMatch = content.match(/"title"\s*:\s*"([^"]+)"/i);
                return jsonMatch?.[1]?.trim();
            }
        } catch (e) {
            log('Title extraction error:', e);
        }
        return document.title || location.hostname;
    };

    // 统一内容检测 —— 以 DOM 为准，不依赖 contentType 或 URL 模式（它们容易错）
    const detectFeedContent = () => {
        const url = location.href.toLowerCase();
        
        // 明确排除 sitemap.xml
        if (url.endsWith('/sitemap.xml')) {
            log('Excluding sitemap.xml file');
            return false;
        }

        // ============================================================
        // 【第一层：DOM 根标签检测】最可靠，完全不依赖 MIME 或 URL 后缀
        // 浏览器直接加载 XML feed 时，documentElement 就是 <rss> / <feed> / <rdf>
        // 这是我们最该信任的信号
        // ============================================================
        const docTag = (document.documentElement?.tagName || '').toLowerCase();
        if (docTag === 'rss' || docTag === 'feed' || docTag === 'rdf') {
            const content = document.documentElement.outerHTML;
            const title = extractTitle(content, true);
            log('Detected feed via documentElement tag:', docTag);
            sendCandidates([{ name: title, url: location.href, isDirect: true }]);
            return true;
        }

        // ============================================================
        // 【第二层：body.textContent 检测】Edge/Chrome XML viewer 包装场景
        // 无论浏览器用什么方式显示 feed，真正的内容一定会出现在
        // body.textContent 里（要么是原始 XML，要么是渲染后的文本）
        // ============================================================
        const bodyText = (document.body?.textContent || '').trim();
        if (bodyText) {
            // XML feed：文本开头就是 feed 根元素或 XML 声明
            if (/^(?:<\?xml\s|<rss[\s>]|<feed[\s>])/i.test(bodyText)) {
                log('Detected XML feed via body text start');
                const isXml = /<(rss|feed)[\s>]/i.test(bodyText);
                const title = extractTitle(bodyText, true);
                sendCandidates([{ name: title, url: location.href, isDirect: true }]);
                return true;
            }
            // JSON feed：{ ... "version": "https://jsonfeed.org/version/" ... "items": [...] }
            if (bodyText.startsWith('{')) {
                try {
                    const json = JSON.parse(bodyText);
                    if (json?.version && json?.items) {
                        log('Detected JSON feed via body text');
                        sendCandidates([{ name: json.title || document.title, url: location.href, isDirect: true }]);
                        return true;
                    }
                } catch(e) {}
            }
        }

        // ============================================================
        // 【第三层：text/html 早返回】HTML 页面本身绝不是 feed 文档
        // （GitHub、博客、论坛等，它们要靠 scanLinks 找 <link rel=alternate>）
        // 但上面两层已经检查了 DOM 和 body 文本，这里不会误伤
        // ============================================================
        const contentType = document.contentType;
        if (contentType.includes('text/html')) {
            return false;
        }

        // ============================================================
        // 【兜底层】非 text/html 但以上都没命中的少见场景
        // 保留旧的 contentType/URL 模式匹配作为最后手段
        // ============================================================
        const isText = contentType.includes('text/plain');
        const rawContent = document.body?.textContent || '';
        
        // 纯文本检测
        if (isText && rawContent) {
            const isXml = /<\?xml\s+version=/i.test(rawContent) && 
                         (/<rss[\s>]/.test(rawContent) || /<feed[\s>]/.test(rawContent));
            
            const isJson = rawContent.trim().startsWith('{') && 
                          /"version":/.test(rawContent) && 
                          /"items"\s*:/.test(rawContent);
            
            if (isXml || isJson) {
                const title = extractTitle(rawContent, isXml);
                sendCandidates([{ name: title, url: location.href, isDirect: true }]);
                return true;
            }
            return false;
        }
        
        // XML 检测（contentType 暗示 xml 或 URL 后缀）
        if (contentType.includes('xml') || /\.(xml|rss|atom)$/i.test(location.href)) {
            let content = '';
            if (document.documentElement) {
                const xmlDecl = document.firstChild?.nodeType === 7 ? document.firstChild.data : '';
                content = xmlDecl + document.documentElement.outerHTML;
            }
            
            const isFeed = /<(rss|feed)[\s>]/i.test(content);
            if (isFeed) {
                const title = extractTitle(content);
                sendCandidates([{ 
                    name: title, 
                    url: location.href,
                    isDirect: true,
                    hasAtomNS: /xmlns:?atom=/i.test(content)
                }]);
                return true;
            }
        }
        
        // JSON 检测
        if (contentType.includes('json') || /\.json$/i.test(location.href)) {
            try {
                const content = (document.body?.textContent || '').trim();
                if (!content.startsWith('{')) return false;
                
                const json = JSON.parse(content);
                if (json?.version && json?.items) {
                    sendCandidates([{ 
                        name: json.title || document.title, 
                        url: location.href,
                        isDirect: true
                    }]);
                    return true;
                }
            } catch(e) {}
        }
        return false;
    };
    
    // 链接扫描 - 只排除sitemap.xml
    const scanLinks = () => {
        const candidates = [];
        const isFeedLink = link => {
            const type = (link.getAttribute('type') || '').toLowerCase();
            const rel = (link.getAttribute('rel') || '').toLowerCase();
            return /(rss|atom|feed)/.test(type) || 
                  (rel.includes('alternate') && /(rss|atom)/.test(type)) ||
                  rel.includes('feed');
        };
        
        // 扫描 link 标签
        document.querySelectorAll('link[href]').forEach(link => {
            if (!isFeedLink(link)) return;
            const href = link.getAttribute('href')?.trim();
            if (!href) return;
            
            try {
                const url = new URL(href, location.href).href;
                
                // 仅排除以sitemap.xml结尾的链接
                if (url.endsWith('/sitemap.xml')) {
                    log('Excluding sitemap.xml link');
                    return;
                }
                
                candidates.push({ 
                    name: link.getAttribute('title') || document.title, 
                    url 
                });
            } catch(e) {}
        });
        
        // 扫描 meta 标签
        document.querySelectorAll('meta[name="alternate"]').forEach(meta => {
            const type = (meta.getAttribute('type') || '').toLowerCase();
            const href = meta.getAttribute('href') || meta.getAttribute('content') || '';
            
            if (/(rss|atom|feed)/.test(type) && href) {
                try {
                    const url = new URL(href, location.href).href;
                    
                    // 仅排除以sitemap.xml结尾的链接
                    if (url.endsWith('/sitemap.xml')) {
                        log('Excluding sitemap.xml meta link');
                        return;
                    }
                    
                    candidates.push({ 
                        name: meta.getAttribute('title') || 'Meta Feed',
                        url
                    });
                } catch(e) {}
            }
        });
        
        // 扫描关键区域的 a 标签
        const zones = ['header', 'nav', 'footer', '.rss', '.feed', '.subscribe', '.social'];
        // URL 后缀明确指向 feed 文件 → 单独成立，无需文本辅助（.rss.xml, .atom 等）
        const feedUrlPattern = /\.(rss|atom|xml|json|rdf)$/i;
        // 路径段匹配 → 完整路径段（后跟 / ? # 或结尾，不能直接跟扩展名）
        const feedPathPattern = /\/(?:feeds?|rss|atom|subscription|subscriptions?)(?!\.[a-z0-9]+)(?:[\/?#]|$)/i;
        // 明确不是 feed 的文件扩展名（.yml 工作流文件、.html 页面等）→ 直接排除
        const notFeedExtPattern = /\.(yml|yaml|html|htm|php|jsp|asp|aspx|txt|md|pdf|doc|docx|js|mjs|css|svg|png|jpg|gif|ico|webp|zip|tar|gz|exe|dmg|apk)$/i;
        // a 标签文本中的 feed 关键词（英文用 \b 边界，中文直接匹配因为 \b 对中文不生效）
        const feedKeywordPattern = /(?:\b(rss|feed|atom)\b|订阅源|订阅)/i;
        
        zones.forEach(selector => {
            const elements = document.querySelectorAll(selector);
            elements.forEach(zone => {
                const anchors = zone.querySelectorAll('a[href]');
                anchors.forEach(anchor => {
                    const href = anchor.getAttribute('href')?.trim();
                    if (!href || href.startsWith('javascript:')) return;
                    
                    // 明确非 feed 的文件扩展名 → 直接跳过
                    if (notFeedExtPattern.test(href)) return;
                    
                    const linkText = (anchor.textContent || '').trim();
                    const hasKeyword = feedKeywordPattern.test(linkText);

                    // URL 后缀匹配 → 直接接受（最可靠）
                    // URL 路径匹配 → 必须同时有文本关键词（防误匹配）
                    const pathMatch = feedPathPattern.test(href);
                    const urlLooksLikeFeed = feedUrlPattern.test(href) || (pathMatch && hasKeyword);
                    if (!urlLooksLikeFeed) return;
                    
                    try {
                        const url = new URL(href, location.href).href;
                        
                        // 排除 sitemap.xml
                        if (url.endsWith('/sitemap.xml')) {
                            log('Excluding sitemap.xml anchor link');
                            return;
                        }
                        // 排除指向当前页面自身的链接（无论什么原因，页面自身 HTML 不是 feed）
                        if (url === location.origin + location.pathname || url === location.href) {
                            log('Excluding self-referencing anchor');
                            return;
                        }
                        
                        candidates.push({
                            name: anchor.getAttribute('title') || anchor.textContent.trim() || 'Feed',
                            url
                        });
                    } catch(e) {}
                });
            });
        });
        
        return candidates;
    };
    
    // 主执行流程
    log('Initialized at', new Date().toISOString());
    if (!detectFeedContent()) {
        // 总是发消息 —— 即使 scanLinks 没找到任何候选，
        // 后台也需要知道当前页面以便触发常见路径探测回退
        const links = scanLinks();
        sendCandidates(links);
    }
})();