/**
 * Runs on every container start (`start:prod`). Since 0.7.0 there is nothing to seed: channels
 * belong to servers, which people create in the app (an upgraded installation gets its "AIDis"
 * server from the 0.7.0 migration). Never creates users or passwords.
 */
console.log(JSON.stringify({ level: 'info', service: 'aidis-seed', event: 'seed.noop', msg: 'Nothing to seed since 0.7.0' }));
