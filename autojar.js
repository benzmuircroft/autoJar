const autojar = async (options) => {
  return new Promise(async (resolve) => {
    
    const Corestore = require('corestore');
    const Hyperswarm = require('hyperswarm');
    const b4a = require('b4a');
    const crypto = require('hypercore-crypto');
    const goodbye = (await import('graceful-goodbye')).default;
    const ProtomuxRPC = require('protomux-rpc');

    let swarm, clients = {}, inputs = {}, outputs = {};

    function broadcast(d) { // pushed to everyone
      for (let p in clients) {
        clients[p].event('broadcast', b4a.from(JSON.stringify(d)));
      }
    }

    let store = new Corestore(options.folderName)
    await store.ready();
    
    let index = store.get({ keyPair: options.keyPair });
    await index.ready();
    await index.update(); // untested
    if (index.length) {
      inputs = JSON.parse(await index.get(index.length -1)); // todo: should be io = { inputs: {}, outputs: { what: { key, date } } }
    }

    swarm = new Hyperswarm();
    swarm.on('connection', function(peer) {
      store.replicate(peer);
      const rpc = new ProtomuxRPC(peer);
      rpc.remotePublicKey = peer.remotePublicKey.toString('hex');
      clients[rpc.remotePublicKey] = rpc;
      rpc.on('close', async function() {
        delete clients[rpc.remotePublicKey];
      });
      rpc.respond('broadcast', async function(d) {
        d = JSON.parse(d.toString());
        outputs = { ...outputs, ...d };
        await options.onData(d);
      });
      broadcast({ role: options.role, inputs, indexingKey: options.keyPair.publicKey.toString('hex') });
    });
    await swarm.join(b4a.alloc(32).fill('root'), { server: true, client: true });
    await swarm.flush();
    goodbye(() => swarm.destroy());

    const get = async function(publicKey) { // should look at the length first
      let core = await store.get({ key: publicKey }); // todo: should be higher level
      await core.ready();
      await core.update(); // untested
      const res = JSON.parse(await core.get(core.length -1));
      await core.close(); // untested
      return res;
    }
    
    const put = async function(key, value) {
      let core, purge = false;
      // locate and destroy
      if (inputs[key]) {
        purge = JSON.parse(JSON.stringify(inputs[key]));
        delete inputs[key];
      }
      // create a new location on the store
      const keyPair = crypto.keyPair();
      core = await store.get({ keyPair });
      await core.ready();
      inputs[key] = {
        publicKey: keyPair.publicKey.toString('hex'),
        secretKey: options.encrypt(keyPair.secretKey.toString('hex')) // todo: should be issued by root so others can take over ...
      };
      // update your index for others to find your cores
      await index.purge();
      index = await store.get({ keyPair: options.keyPair });
      await index.append(JSON.stringify(inputs));
      // put the new data into your new location
      await core.append(JSON.stringify(value));
      await core.close(); // untested
      // tell others
      broadcast({ role: options.role, inputs, indexingKey: options.keyPair.publicKey.toString('hex') });
      // kill the old data after just incase other people were getting the old while you were updating
      if (purge) {
        core = await store.get({ 
          keyPair: {
            publicKey: b4a.from(purge.publicKey, 'hex'),
            secretKey: b4a.from(options.decrypt(purge.secretKey), 'hex')
          }
        });
        await core.ready();
        await core.purge();
      }
    };

    resolve({ put, get, inputs, outputs });
    
  });
};

module.exports = autojar;
