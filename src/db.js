'use strict';

const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
let client;
let db;

async function getDb() {
  if (db) return db;
  if (!client) {
    client = new MongoClient(uri);
    await client.connect();
    console.log('✅ MongoDB 已连接');
  }
  db = client.db('saomiaoji');
  return db;
}

module.exports = { getDb };
