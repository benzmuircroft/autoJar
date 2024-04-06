const autojar = async (options) => {
  return new Promise(async (resolve) => {
    
    const Corestore = require('iotore');
    const Hyperswarm = require('hyperswarm');
    const b4a = require('b4a');
    const crypto = require('hypercore-crypto');
    const goodbye = (await import('graceful-goodbye')).default;
    const ProtomuxRPC = require('protomux-rpc');

    let store, // shared with everyone as a multi-writer
    swarm, // to share and declare changes
    everyone = {}, // a list of peers to broadcast to
    ix, // your personal index where you collect permanent and temporary publick keys of cores
    io = {}; // the cache of your ix

    function broadcast(event) { // pushed to everyone
      let mine = {};
      for (const key in io) {
        if (io[key].ismine) mine[key] = { publicKey: io[key].publicKey, role: options.role };
      }
      mine[options.role] = { publicKey: options.keyPair.publicKey.toString('hex'), role: options.role }; // add your own ix so others can fix (see get function)
      for (const peer in everyone) {
        everyone[peer].event('broadcast', b4a.from(JSON.stringify([event, mine])));
      }
    }

    store = new Corestore(options.folderName);
    await store.ready();
    
    ix = store.get({ keyPair: options.keyPair });
    await ix.ready();
    await ix.update();
    if (ix.length) {
      io = JSON.parse(await ix.get(ix.length -1));
      if (ix.length > 1) {
        await ix.purge();
        ix = await store.get({ keyPair: options.keyPair });
        await ix.append(JSON.stringify(io));
      }
    }

    swarm = new Hyperswarm();
    swarm.on('connection', function(peer) {
      store.replicate(peer);
      const mux = new ProtomuxRPC(peer);
      mux.remotePublicKey = peer.remotePublicKey.toString('hex');
      everyone[mux.remotePublicKey] = mux;
      mux.on('close', async function() {
        delete everyone[mux.remotePublicKey];
      });
      mux.respond('broadcast', async function(d) {
        d = JSON.parse(d.toString());
        const event = d[0];
        const data = d[1];
        io = { ...io, ...data };
        await ix.append(JSON.stringify(io)); // will srink on next put or at restart ...
        await options.onData(event, data);
      });
      broadcast('hello');
    });
    await swarm.join(b4a.alloc(32).fill('root'), { server: true, client: true });
    await swarm.flush();
    goodbye(() => swarm.destroy());

    async function get(name) {
      const publicKey = io[name]?.publicKey;
      if (!publicKey) return null;
      let core = await store.get({ key: b4a.from(publicKey, 'hex') });
      await core.ready();
      await core.update();
      let res = null;
      if (core.length) res = JSON.parse(await core.get(core.length -1));
      await core.close();
      // try to see if it has moved while you are away (if so the other user is offline now)
      if (!res && io[io[name].role]) { // look in their ix
        core = await store.get({ key: b4a.from(io[io[name].role].publicKey, 'hex') });
        await core.ready();
        await core.update();
        let fix = null;
        if (core.length) fix = JSON.parse(await core.get(core.length -1)); // got their ix
        await core.close();
        // does their ix have what you want but with a new key ?
        if (fix?.[name] && fix[name].publicKey != publicKey) {
          core = await store.get({ key: b4a.from(fix[name].publicKey, 'hex') });
          await core.ready();
          await core.update();
          if (core.length) res = JSON.parse(await core.get(core.length -1));
          // if successfully found what you want; update your ix
          if (res) {
            io[name].publicKey = fix[name].publicKey;
            await ix.purge();
            ix = await store.get({ keyPair: options.keyPair });
            await ix.append(JSON.stringify(io));
          }
        }
      }
      return res;
    }
    
    async function put(key, value) {
      let core, purge = false;
      // locate and destroy
      if (io[key]) {
        if (io[key].role != options.role) return null;
        purge = JSON.parse(JSON.stringify(io[key]));
        delete io[key];
      }
      // create a new location on the store
      const keyPair = crypto.keyPair();
      core = await store.get({ keyPair });
      await core.ready();
      io[key] = {
        publicKey: keyPair.publicKey.toString('hex'),
        secretKey: options.encrypt(keyPair.secretKey.toString('hex')), // todo: should be issued by root so others can take over ...
        role: options.role
      };
      // update your ix for others to find your io
      await ix.purge();
      ix = await store.get({ keyPair: options.keyPair });
      await ix.append(JSON.stringify(io));
      // put the new data into your new location
      await core.append(JSON.stringify(value));
      await core.close();
      broadcast('update');
      // kill the old data after just incase other people were getting the old while you were updating
      if (purge) {
        core = await store.get({ 
          keyPair: {
            publicKey: b4a.from(purge.publicKey, 'hex'),
            secretKey: b4a.from(options.decrypt(purge.secretKey), 'hex') // todo: should be issued by root so others can take over ...
          }
        });
        await core.ready();
        await core.purge();
      }
    };

    resolve({ put, get, io });
    
  });
};

module.exports = autojar;
