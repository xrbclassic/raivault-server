require('dotenv').config(); // Load variables from .env into the environment

const timestamps = require('./timestamps');

/** Configuration **/
const nanoNodeUrl = process.env.NANO_NODE_URL || `http://[::1]:7002`; // Nano node RPC url
const nanoWorkNodeUrl = process.env.NANO_WORK_NODE_URL || `http://[::1]:7002`; // Nano work node RPC url
const listeningPort = process.env.APP_PORT || 9950; // Port this app will listen on

const useDPoW = !!process.env.USE_DPOW || false; // Is the Distributed Proof of Work system used? (Requires API Key)

const useRedisCache = !!process.env.USE_REDIS || false; // Change this if you are not running a Redis server.  Will use in memory cache instead.
// const redisCacheUrl = process.env.REDIS_HOST || `172.31.25.214`; // Url to the redis server (If used)
// const redisCacheTime = 60 * 60 * 24; // Store work for 24 Hours
// const memoryCacheLength = 800; // How much work to store in memory (If used)

const express = require('express');
const request = require('request-promise-native');
const cors = require('cors');
const { promisify } = require('util');

const workCache = [];
let getCache, putCache;

// Set up the webserver
const app = express();
app.use(cors());
app.use(express.json());

// Serve the production copy of the wallet
app.use(express.static('static'));

// Allow requests to recommended reps
app.get('/api/recommended-representatives', async (req, res) => {
  const reps = await getCache('recommended-reps');
  if (reps) {
    return res.json(JSON.parse(reps));
  } else {
    return await getRecommendedReps();
  }
});

// Allow certain requests to the Nano RPC and cache work requests
app.post('/api/node-api', async (req, res) => {
  const allowedActions = [
    'account_history',
    'account_info',
    'accounts_frontiers',
    'accounts_balances',
    'accounts_pending',
    'block',
    'blocks',
    'block_count',
    'blocks_info',
    'delegators_count',
    'pending',
    'process',
    'representatives_online',
    'validate_account_number',
    'work_generate',
  ];
  if (!req.body.action || allowedActions.indexOf(req.body.action) === -1) {
    return res.status(500).json({ error: `Action ${req.body.action} not allowed` });
  }

  let workRequest = false;
  let representativeRequest = false;
  let nodeOverride = false; // When overriding the node, we don't want to use caching (Someone could inject bad data)
  let nodeUrl = nanoNodeUrl;
  let repCacheKey = `online-representatives`;

  // Check for a node override being used
  if (req.query && req.query.node && req.query.node.length > 4) {
    nodeUrl = req.query.node;
    nodeOverride = true;
  }

  // Cache work requests
  if (req.body.action === 'work_generate' && !nodeOverride) {
    if (!req.body.hash) return res.status(500).json({ error: `Requires valid hash to perform work` });

    const cachedWork = useRedisCache ? await getCache(req.body.hash) : getCache(req.body.hash); // Only redis is an async operation
    if (cachedWork && cachedWork.length) {
      return res.json({ work: cachedWork });
    }
    workRequest = true;
  }

  // Cache the online representatives request
  if (req.body.action === 'representatives_online' && !nodeOverride) {
    const cachedValue = useRedisCache ? await getCache(repCacheKey) : getCache(repCacheKey); // Only redis is an async operation
    if (cachedValue && cachedValue.length) {
      return res.json(JSON.parse(cachedValue));
    }
    representativeRequest = true;
  }

  // Determine if this should go to the work node instead
  if ((workRequest || representativeRequest) && !nodeOverride) {
    nodeUrl = nanoWorkNodeUrl;
  }

  // Determine if we use DPoW instead of proxying to the nano node
  if (workRequest && useDPoW) {
    return request({
      method: 'post',
      uri: process.env.DPOW_URL,
      json: true,
      body: {
        user: process.env.DPOW_USER,
        api_key: process.env.DPOW_KEY,
        hash: req.body.hash,
        timeout: 10,
      }
    })
      .then(async (dpowRes) => {
        if (dpowRes && dpowRes.work) {
          putCache(req.body.hash, dpowRes.work);
        }
        res.json(dpowRes)
      })
      .catch(err => res.status(500).json(err.toString()));
  }

  // Send the request to the Nano node and return the response
  request({ method: 'post', uri: nodeUrl, body: req.body, json: true })
    .then(async (proxyRes) => {
      if (proxyRes && !nodeOverride) {
        if (workRequest && proxyRes.work) {
          putCache(req.body.hash, proxyRes.work);
        }
        if (representativeRequest && proxyRes.representatives) {
          putCache(repCacheKey, JSON.stringify(proxyRes), 5 * 60); // Cache online representatives for 5 minutes
        }
      }

      // Add timestamps to certain requests
      if (req.body.action === 'account_history') {
        proxyRes = await timestamps.mapAccountHistory(proxyRes);
      }
      if (req.body.action === 'blocks_info') {
        proxyRes = await timestamps.mapBlocksInfo(req.body.hashes, proxyRes);
      }
      if (req.body.action === 'pending') {
        proxyRes = await timestamps.mapPending(proxyRes);
      }
      res.json(proxyRes)
    })
    .catch(err => res.status(500).json(err.toString()));
});

// Redirect all other GET requests to wallet
app.get('/*', (req, res) => res.sendFile(`${__dirname}/static/index.html`));

app.listen(listeningPort, () => console.log(`App listening on port ${listeningPort}!`));

// Configure the cache functions to work based on if we are using redis or not
if (useRedisCache) {
  const cacheClient = require('redis').createClient({
    host: redisCacheUrl,
  });
  cacheClient.on('ready', () => console.log(`Redis Work Cache: Connected`));
  cacheClient.on('error', (err) => console.log(`Redis Work Cache: Error`, err));
  cacheClient.on('end', () => console.log(`Redis Work Cache: Connection closed`));

  getCache = promisify(cacheClient.get).bind(cacheClient);
  putCache = (hash, work, time) => {
    cacheClient.set(hash, work, 'EX', time || redisCacheTime); // Store the work for 24 hours
  };
} else {
  getCache = hash => {
    const existingHash = workCache.find(w => w.hash === hash);
    return existingHash ? existingHash.work : null;
  };
  putCache = (hash, work, time) => {
    if (time) return; // If a specific time is specified, don't cache at all for now
    workCache.push({ hash, work });
    if (workCache.length >= memoryCacheLength) workCache.shift(); // If the list is too long, prune it.
  };
}

function getRecommendedReps() {
  return request({
    method: 'get',
    uri: `https://mynano.ninja/api/accounts/verified`,
    json: true,
  }).then(res => {
    putCache('recommended-reps', JSON.stringify(res), 45 * 60); // Store for 45 minutes

    return res;
  });
}

// Recache the recommended reps every 15 minutes
function pollRecommended() {
  getRecommendedReps();
  setInterval(getRecommendedReps, 15 * 60 * 1000);
}

pollRecommended();
