import * as fs from 'fs';
import * as path from 'path';

const DB_PATH = path.join(__dirname, '..', '..', 'server', 'db.json');

export interface UserAccount {
  nodeId: string;
  nodeSecret: string;
  points: number;
  benchmarkScore: number;
  jobsCompleted: number;
  bytesProcessed: number;
}

export interface DatabaseSchema {
  users: Record<string, UserAccount>;
}

let dbData: DatabaseSchema = { users: {} };

function loadDB() {
  try {
    const parentDir = path.dirname(DB_PATH);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    
    if (fs.existsSync(DB_PATH)) {
      const content = fs.readFileSync(DB_PATH, 'utf8');
      dbData = JSON.parse(content);
      if (!dbData.users) dbData.users = {};
    } else {
      saveDB();
    }
  } catch (e) {
    console.error('Failed to load database, using empty state:', e);
  }
}

function saveDB() {
  try {
    const parentDir = path.dirname(DB_PATH);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    fs.writeFileSync(DB_PATH, JSON.stringify(dbData, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save database:', e);
  }
}

loadDB();

export const db = {
  authenticate(nodeId: string, nodeSecret: string): UserAccount {
    if (!nodeId || !nodeSecret) {
      throw new Error('Authentication requires both nodeId and nodeSecret');
    }

    const users = dbData.users;
    if (users[nodeId]) {
      if (users[nodeId].nodeSecret !== nodeSecret) {
        throw new Error('Invalid nodeSecret credentials');
      }
      return { ...users[nodeId] };
    }

    const newUser: UserAccount = {
      nodeId,
      nodeSecret,
      points: 100.0,
      benchmarkScore: 0,
      jobsCompleted: 0,
      bytesProcessed: 0
    };

    users[nodeId] = newUser;
    saveDB();
    console.log(`🆕 Registered new node client: ${nodeId} (+100.0 welcome credits)`);
    return { ...newUser };
  },

  updateBenchmark(nodeId: string, score: number): UserAccount {
    const user = dbData.users[nodeId];
    if (!user) throw new Error(`User not found: ${nodeId}`);
    user.benchmarkScore = Math.max(0, Number(score) || 0);
    saveDB();
    console.log(`⏱️ Updated benchmark score for ${nodeId} to: ${user.benchmarkScore}`);
    return { ...user };
  },

  getAccount(nodeId: string): UserAccount | null {
    const user = dbData.users[nodeId];
    if (!user) return null;
    return { ...user };
  },

  transferPoints(fromNodeId: string, toNodeId: string, amount: number, bytesProcessed = 0): { client: UserAccount; provider: UserAccount } {
    const users = dbData.users;
    const client = users[fromNodeId];
    const provider = users[toNodeId];

    if (!client) throw new Error(`Client node not found: ${fromNodeId}`);
    if (!provider) throw new Error(`Provider node not found: ${toNodeId}`);

    const transferAmt = Math.max(0, Number(amount) || 0);
    if (client.points < transferAmt) {
      throw new Error(`Insufficient point balance: client has ${client.points.toFixed(2)}, needs ${transferAmt.toFixed(2)}`);
    }

    client.points -= transferAmt;
    provider.points += transferAmt;

    provider.jobsCompleted = (provider.jobsCompleted || 0) + 1;
    provider.bytesProcessed = (provider.bytesProcessed || 0) + Number(bytesProcessed || 0);

    saveDB();
    console.log(`💸 Point Transfer: ${transferAmt.toFixed(2)} credits from ${fromNodeId} to ${toNodeId}`);
    return { client: { ...client }, provider: { ...provider } };
  },

  adjustPoints(nodeId: string, balance: number): UserAccount {
    const user = dbData.users[nodeId];
    if (!user) throw new Error(`Node not found: ${nodeId}`);
    user.points = Math.max(0, Number(balance) || 0);
    saveDB();
    return { ...user };
  }
};
export default db;
