function groupsWithSources(proxies, providers = {}, definitions = [], localNames = []) {
  const groups = new Map(definitions.map(group => [group.name, group]));
  return Object.values(proxies).filter(group => Array.isArray(group.all)).map(group => {
    const definition = groups.get(group.name), used = definition?.use;
    const explicit = new Set(definition?.proxies || []);
    if (definition?.['include-all'] || definition?.['include-all-proxies']) for (const name of localNames) explicit.add(name);
    const sources = new Map();
    for (const [providerName, provider] of Object.entries(providers)) {
      if (provider.vehicleType === 'Compatible' || definition && !definition['include-all'] && !definition['include-all-providers'] && !(Array.isArray(used) && used.includes(providerName))) continue;
      for (const node of provider.proxies || []) { if (!sources.has(node.name)) sources.set(node.name, []); sources.get(node.name).push({ provider: providerName, node }); }
    }
    const nodes = [...new Set(group.all)].flatMap(name => {
      const matches = sources.get(name) || [], sourceNames = matches.map(source => source.provider);
      const rows = [...matches];
      if (!matches.length || explicit.has(name)) rows.unshift({ provider: null, node: proxies[name] });
      return rows.map(({provider, node}) => ({ id: JSON.stringify([provider, name]), name, provider, providers: sourceNames, type: node?.type, delay: node?.history?.at(-1)?.delay || 0 }));
    });
    return { name: group.name, type: group.type, now: group.now, nodes };
  });
}
module.exports = { groupsWithSources };
