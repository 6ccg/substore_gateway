async function operator(input, targetPlatform, context) {
  input = input || {};
  var $content = input.$content;
  var $options = input.$options || {};
  var query = ($options._req && $options._req.query) || {};
  var files = $substore.read('files') || [];
  var builtInProfiles = {
    lite: ['dg-v1-profile-lite', 'shouhou-688-0.2-rule-lite-noadb']
  };
  var manualGroup = '\u2708\uFE0F \u624B\u52A8\u9009\u62E9';
  var landingGroup = '\uD83E\uDE9C \u843D\u5730\u524D\u7F6E';
  var nativeLandingGroup = '\uD83D\uDEEC \u539F\u751F\u843D\u5730';

  function splitList(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    return String(value).split(',').map(function (item) { return item.trim(); }).filter(function (item) { return item; });
  }

  function findFile(names) {
    var list = Array.isArray(names) ? names : [names];
    for (var i = 0; i < list.length; i++) {
      for (var j = 0; j < files.length; j++) {
        if (files[j].name === list[i] && files[j].content) return files[j];
      }
    }
    return null;
  }

  function readConfig(names) {
    var file = findFile(names);
    if (!file) return null;
    var text = file.content || '';
    try {
      if (/^\s*[\[{]/.test(text)) return JSON.parse(text);
    } catch (e) {}
    return ProxyUtils.yaml.safeLoad(text);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function ensureArray(obj, key) {
    if (!Array.isArray(obj[key])) obj[key] = [];
    return obj[key];
  }

  function mergeObject(target, source) {
    if (!source) return target;
    for (var key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key];
    }
    return target;
  }

  function indexOfName(list, name) {
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].name === name) return i;
    }
    return -1;
  }

  function pushUnique(list, item) {
    if (list.indexOf(item) < 0) list.push(item);
  }

  function mergeGroup(groups, group) {
    if (!group || !group.name) return;
    var patch = clone(group);
    var plusProxies = patch['proxies+'];
    delete patch['proxies+'];
    var idx = indexOfName(groups, patch.name);
    if (idx < 0) {
      if (plusProxies) {
        patch.proxies = Array.isArray(patch.proxies) ? patch.proxies : [];
        for (var a = 0; a < plusProxies.length; a++) pushUnique(patch.proxies, plusProxies[a]);
      }
      groups.push(patch);
      return;
    }
    var current = groups[idx];
    mergeObject(current, patch);
    if (plusProxies) {
      current.proxies = Array.isArray(current.proxies) ? current.proxies : [];
      for (var b = 0; b < plusProxies.length; b++) pushUnique(current.proxies, plusProxies[b]);
    }
  }

  function insertBeforeMatch(rules, addRules) {
    if (!Array.isArray(addRules) || !addRules.length) return rules;
    var out = [];
    var inserted = false;
    for (var i = 0; i < rules.length; i++) {
      if (!inserted && /^MATCH\s*,/i.test(String(rules[i]))) {
        for (var a = 0; a < addRules.length; a++) if (out.indexOf(addRules[a]) < 0) out.push(addRules[a]);
        inserted = true;
      }
      if (out.indexOf(rules[i]) < 0) out.push(rules[i]);
    }
    if (!inserted) {
      for (var b = 0; b < addRules.length; b++) if (out.indexOf(addRules[b]) < 0) out.push(addRules[b]);
    }
    return out;
  }

  function insertAfterLastMatch(rules, patternText, addRules) {
    if (!Array.isArray(addRules) || !addRules.length) return rules;
    var pattern = patternText ? new RegExp(patternText, 'i') : null;
    var insertAt = -1;
    if (pattern) {
      for (var i = 0; i < rules.length; i++) {
        if (pattern.test(String(rules[i]))) insertAt = i;
      }
    }
    if (insertAt < 0) return insertBeforeMatch(rules, addRules);
    var out = [];
    for (var r = 0; r < rules.length; r++) {
      if (out.indexOf(rules[r]) < 0) out.push(rules[r]);
      if (r === insertAt) {
        for (var a = 0; a < addRules.length; a++) {
          if (out.indexOf(addRules[a]) < 0) out.push(addRules[a]);
        }
      }
    }
    return out;
  }

  function loadPatch(name) {
    var patch = readConfig([name, 'dg-v1-patch-' + name, 'patch-' + name]);
    if (!patch) throw new Error('Patch file not found: ' + name);
    return patch;
  }

  function applyPatch(yamlObj, patch, runtime) {
    if (!patch) return;
    if (patch['rule-providers']) yamlObj['rule-providers'] = mergeObject(yamlObj['rule-providers'] || {}, patch['rule-providers']);
    if (patch.ruleProviders) yamlObj['rule-providers'] = mergeObject(yamlObj['rule-providers'] || {}, patch.ruleProviders);
    var groups = ensureArray(yamlObj, 'proxy-groups');
    var groupLists = [patch.proxyGroups, patch['proxy-groups'], patch.appendProxyGroups, patch.mergeProxyGroups];
    for (var i = 0; i < groupLists.length; i++) {
      if (Array.isArray(groupLists[i])) {
        for (var g = 0; g < groupLists[i].length; g++) mergeGroup(groups, groupLists[i][g]);
      }
    }
    if (patch.removeProxyGroupPattern) {
      var rg = new RegExp(patch.removeProxyGroupPattern, 'i');
      yamlObj['proxy-groups'] = groups.filter(function (group) { return !rg.test(String(group.name || '')); });
    }
    if (patch.removeProxyGroupNames && Array.isArray(patch.removeProxyGroupNames)) {
      yamlObj['proxy-groups'] = yamlObj['proxy-groups'].filter(function (group) { return patch.removeProxyGroupNames.indexOf(group.name) < 0; });
    }
    var rules = ensureArray(yamlObj, 'rules');
    if (patch.removeRulePattern) {
      var rr = new RegExp(patch.removeRulePattern, 'i');
      rules = rules.filter(function (rule) { return !rr.test(String(rule)); });
      yamlObj.rules = rules;
    }
    if (patch.prependRules && Array.isArray(patch.prependRules)) {
      for (var p = patch.prependRules.length - 1; p >= 0; p--) {
        if (rules.indexOf(patch.prependRules[p]) < 0) rules.unshift(patch.prependRules[p]);
      }
    }
    if (patch.insertRulesAfter && patch.insertRulesAfter.rules) {
      yamlObj.rules = insertAfterLastMatch(yamlObj.rules, patch.insertRulesAfter.pattern, patch.insertRulesAfter.rules);
      rules = yamlObj.rules;
    }
    if (patch.rules && Array.isArray(patch.rules)) yamlObj.rules = insertBeforeMatch(yamlObj.rules, patch.rules);
    if (patch.appendRules && Array.isArray(patch.appendRules)) yamlObj.rules = insertBeforeMatch(yamlObj.rules, patch.appendRules);
    if (patch.removeRuleProviderPattern && yamlObj['rule-providers']) {
      var rp = new RegExp(patch.removeRuleProviderPattern, 'i');
      for (var key in yamlObj['rule-providers']) {
        if (rp.test(key)) delete yamlObj['rule-providers'][key];
      }
    }
    if (patch.sourceTransforms) {
      runtime.sourceTransforms = runtime.sourceTransforms || {};
      for (var sourceName in patch.sourceTransforms) {
        runtime.sourceTransforms[sourceName] = patch.sourceTransforms[sourceName];
      }
    }
  }

  function applyTransform(proxy, transform) {
    if (!transform) return proxy;
    var next = clone(proxy);
    if (transform.set) {
      for (var key in transform.set) next[key] = transform.set[key];
    }
    if (transform.delete && Array.isArray(transform.delete)) {
      for (var i = 0; i < transform.delete.length; i++) delete next[transform.delete[i]];
    }
    if (transform.prefix && next.name) next.name = String(transform.prefix) + next.name;
    if (transform.suffix && next.name) next.name = String(next.name) + String(transform.suffix);
    return next;
  }

  function sourceSpec(text) {
    var raw = String(text || '').trim();
    var idx = raw.indexOf(':');
    if (idx > 0) {
      return { type: raw.slice(0, idx), name: raw.slice(idx + 1), raw: raw };
    }
    return { type: 'sub', name: raw, raw: raw };
  }

  function sourceId(text) {
    var spec = sourceSpec(text);
    return spec.type + ':' + spec.name;
  }

  function hasSourceName(list, name) {
    for (var i = 0; i < list.length; i++) {
      if (sourceSpec(list[i]).name === name) return true;
    }
    return false;
  }

  function addSource(list, value) {
    if (!value) return;
    var id = sourceId(value);
    for (var i = 0; i < list.length; i++) {
      if (sourceId(list[i]) === id) return;
    }
    list.push(value);
  }

  function sourceMap(list) {
    var map = {};
    for (var i = 0; i < list.length; i++) map[sourceId(list[i])] = true;
    return map;
  }

  function sourceOrder(spec) {
    var name = String((spec && spec.name) || '').toLowerCase();
    if (name === 'warp') return 20;
    if (name === 'landing') return 30;
    if (name === 'vpngate') return 40;
    return 10;
  }

  function orderedSourceSpecs(sourceNames) {
    var specs = [];
    for (var i = 0; i < sourceNames.length; i++) {
      specs.push({ spec: sourceSpec(sourceNames[i]), index: i });
    }
    specs.sort(function (a, b) {
      var diff = sourceOrder(a.spec) - sourceOrder(b.spec);
      if (diff) return diff;
      return a.index - b.index;
    });
    var out = [];
    for (var j = 0; j < specs.length; j++) out.push(specs[j].spec);
    return out;
  }

  async function produceSource(spec) {
    var type = spec.type || 'sub';
    try {
      return await produceArtifact({ type: type, name: spec.name, platform: 'ClashMeta', produceType: 'internal' });
    } catch (e) {
      if (type === 'sub') {
        return await produceArtifact({ type: 'subscription', name: spec.name, platform: 'ClashMeta', produceType: 'internal' });
      }
      throw e;
    }
  }

  function isLandingSource(spec, landingMap) {
    return !!landingMap[spec.type + ':' + spec.name];
  }

  function moveGroupAfter(yamlObj, groupName, afterName) {
    var groups = ensureArray(yamlObj, 'proxy-groups');
    var groupIndex = indexOfName(groups, groupName);
    var afterIndex = indexOfName(groups, afterName);
    if (groupIndex < 0 || afterIndex < 0) return;
    var group = groups.splice(groupIndex, 1)[0];
    if (groupIndex < afterIndex) afterIndex--;
    groups.splice(afterIndex + 1, 0, group);
  }

  function configureManualSelectGroup(yamlObj, frontProxyNames) {
    var groups = ensureArray(yamlObj, 'proxy-groups');
    var idx = indexOfName(groups, manualGroup);
    if (idx < 0) {
      groups.push({ name: manualGroup, type: 'select', proxies: [] });
      idx = indexOfName(groups, manualGroup);
    }
    var group = groups[idx];
    group.type = group.type || 'select';
    group.proxies = [];
    for (var i = 0; i < frontProxyNames.length; i++) pushUnique(group.proxies, frontProxyNames[i]);
    delete group['include-all'];
    delete group.filter;
    delete group.excludeFilter;
  }

  function configureLandingFrontGroup(yamlObj, frontProxyNames) {
    var groups = ensureArray(yamlObj, 'proxy-groups');
    var idx = indexOfName(groups, landingGroup);
    if (idx < 0) return;
    var group = groups[idx];
    group.type = group.type || 'select';
    group.proxies = [];
    for (var i = 0; i < frontProxyNames.length; i++) pushUnique(group.proxies, frontProxyNames[i]);
    delete group['include-all'];
    delete group.filter;
    delete group.excludeFilter;
    moveGroupAfter(yamlObj, landingGroup, manualGroup);
  }

  function configureNativeLandingGroup(yamlObj, landingProxyNames) {
    var groups = ensureArray(yamlObj, 'proxy-groups');
    var idx = indexOfName(groups, nativeLandingGroup);
    if (idx < 0) {
      groups.push({ name: nativeLandingGroup, type: 'select', proxies: [], icon: 'https://cdn.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Airport.png' });
      idx = indexOfName(groups, nativeLandingGroup);
    }
    var group = groups[idx];
    group.type = group.type || 'select';
    group.icon = group.icon || 'https://cdn.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Airport.png';
    group.proxies = [];
    for (var i = 0; i < landingProxyNames.length; i++) pushUnique(group.proxies, landingProxyNames[i]);
    if (!group.proxies.length) pushUnique(group.proxies, 'DIRECT');
    delete group['include-all'];
    delete group.filter;
    delete group.excludeFilter;
    moveGroupAfter(yamlObj, nativeLandingGroup, landingGroup);
  }

  function addGroupProxy(group, proxyName, position) {
    if (!group || !proxyName) return;
    group.proxies = Array.isArray(group.proxies) ? group.proxies : [];
    if (group.proxies.indexOf(proxyName) >= 0) return;
    if (typeof position === 'number' && position >= 0 && position < group.proxies.length) group.proxies.splice(position, 0, proxyName);
    else group.proxies.push(proxyName);
  }

  function expandFrontProxyGroups(yamlObj, frontProxyNames, includeNativeLanding) {
    var groups = ensureArray(yamlObj, 'proxy-groups');
    var skipGroups = {};
    skipGroups[manualGroup] = true;
    skipGroups['\uD83D\uDE80 \u8282\u70B9\u9009\u62E9'] = true;
    skipGroups[landingGroup] = true;
    skipGroups[nativeLandingGroup] = true;
    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];
      if (!group || skipGroups[group.name] || !Array.isArray(group.proxies) || group.proxies.indexOf(manualGroup) < 0) continue;
      var shouldExpandFrontProxies = group['front-proxies'] === true || group['front-proxies'] === 'true';
      var hasExplicitNativeLanding = group.proxies.indexOf(nativeLandingGroup) >= 0;
      var shouldInsertNativeLanding = includeNativeLanding && !hasExplicitNativeLanding;
      var proxies = [];
      for (var i = 0; i < group.proxies.length; i++) {
        var proxyName = group.proxies[i];
        if (shouldExpandFrontProxies && frontProxyNames.indexOf(proxyName) >= 0) continue;
        pushUnique(proxies, proxyName);
        if (proxyName === manualGroup) {
          if (shouldInsertNativeLanding) pushUnique(proxies, nativeLandingGroup);
          if (shouldExpandFrontProxies) {
            for (var p = 0; p < frontProxyNames.length; p++) pushUnique(proxies, frontProxyNames[p]);
          }
        }
      }
      group.proxies = proxies;
      delete group['front-proxies'];
      delete group['include-all'];
      delete group.filter;
      delete group.excludeFilter;
    }
  }

  function configureLandingAwareGroups(yamlObj, frontProxyNames) {
    var groups = ensureArray(yamlObj, 'proxy-groups');
    var rocket = groups[indexOfName(groups, '\uD83D\uDE80 \u8282\u70B9\u9009\u62E9')];
    addGroupProxy(rocket, nativeLandingGroup, 1);
    expandFrontProxyGroups(yamlObj, frontProxyNames, true);
  }

  var patchNames = splitList(query.patches);
  var sources = splitList(query.sources);
  var landingSources = splitList(query.landingSources);
  if (!sources.length) throw new Error('No sources selected');
  if (patchNames.indexOf('audit') >= 0 && !landingSources.length) throw new Error('Anti/CN audit requires landingSources');
  if (landingSources.length && patchNames.indexOf('landing') < 0) {
    var auditIndex = patchNames.indexOf('audit');
    if (auditIndex >= 0) patchNames.splice(auditIndex, 0, 'landing');
    else patchNames.push('landing');
  }
  for (var ls = 0; ls < landingSources.length; ls++) addSource(sources, landingSources[ls]);
  var landingMap = sourceMap(landingSources);

  var profileNames = builtInProfiles.lite;
  var profileFile = findFile(profileNames);
  if (!profileFile) throw new Error('Profile file not found: lite');
  var yamlObj = ProxyUtils.yaml.safeLoad(profileFile.content);
  if (!yamlObj) yamlObj = {};
  yamlObj.proxies = Array.isArray(yamlObj.proxies) ? yamlObj.proxies : [];
  var runtime = { sourceTransforms: {} };
  for (var pi = 0; pi < patchNames.length; pi++) applyPatch(yamlObj, loadPatch(patchNames[pi]), runtime);

  var allProxies = [];
  var frontProxyNames = [];
  var landingProxyNames = [];
  var sourceSpecs = orderedSourceSpecs(sources);
  for (var si = 0; si < sourceSpecs.length; si++) {
    var spec = sourceSpecs[si];
    var items = await produceSource(spec);
    var transform = runtime.sourceTransforms[spec.name] || runtime.sourceTransforms[spec.raw] || runtime.sourceTransforms['*'];
    var landingSource = isLandingSource(spec, landingMap);
    if (patchNames.indexOf('landing') >= 0 && landingSource) transform = { set: { 'dialer-proxy': landingGroup } };
    for (var ii = 0; ii < items.length; ii++) {
      var proxy = applyTransform(items[ii], transform);
      if (!landingSource && proxy && proxy.name) pushUnique(frontProxyNames, proxy.name);
      if (landingSource && proxy && proxy.name) pushUnique(landingProxyNames, proxy.name);
      allProxies.push(proxy);
    }
  }
  if (!allProxies.length) throw new Error('No proxies matched current options');
  configureManualSelectGroup(yamlObj, frontProxyNames);
  if (patchNames.indexOf('landing') >= 0) {
    configureLandingFrontGroup(yamlObj, frontProxyNames);
    configureNativeLandingGroup(yamlObj, landingProxyNames);
    configureLandingAwareGroups(yamlObj, frontProxyNames);
  } else {
    expandFrontProxyGroups(yamlObj, frontProxyNames, false);
  }
  yamlObj.proxies = allProxies.concat(yamlObj.proxies);
  var out = ProxyUtils.yaml.dump(yamlObj);
  out = out.replace(/^external-controller:\s*'([^']+)'/m, 'external-controller: $1');
  out = out.replace(/^(\s*(?:ip|ipv6):\s*)([0-9a-fA-F:.]+\/\d+)\s*$/gm, '$1"$2"');
  $content = out;
  return { $content: $content, $options: $options, $file: input.$file };
}
