const readline = require('readline');

const {
  INDEX_FILENAME,
  NOTE_TYPES,
  PROTOCOL_VERSION,
  SERVER_INFO,
  createRuntime,
} = require('./runtime');
const { buildIndex } = require('./index');
const { findOverlapHits, codexContinuityOverlap } = require('./overlap');
const { codexContinuitySessionContext, codexContinuitySessionDigest, codexContinuitySessionSearch } = require('./session');
const { queryDocuments } = require('./scoring');
const {
  createToolRegistry,
  codexContinuityNoteUpdateApply,
  codexContinuityNoteUpdateDraft,
  codexContinuitySessionNoteDraft,
} = require('./tools');

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  send({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      data,
    },
  });
}

function toolResultPayload(data) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, null, 2),
      },
    ],
    structuredContent: data,
    isError: false,
  };
}

async function handleMessage(runtime, message) {
  if (!message || message.jsonrpc !== '2.0') {
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(message, 'id')) {
    return;
  }

  const { id, method, params } = message;
  const tools = createToolRegistry(runtime);

  if (method === 'initialize') {
    sendResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: {
          listChanged: true,
        },
      },
      serverInfo: SERVER_INFO,
    });
    return;
  }

  if (method === 'tools/list') {
    sendResult(id, {
      tools: Object.entries(tools).map(([name, spec]) => ({
        name,
        description: spec.description,
        inputSchema: spec.inputSchema,
      })),
    });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const tool = tools[toolName];
    if (!tool) {
      sendError(id, -32602, `Unknown tool: ${toolName}`);
      return;
    }

    try {
      const result = tool.run(params?.arguments || {});
      sendResult(id, toolResultPayload(result));
    } catch (error) {
      sendResult(id, {
        content: [
          {
            type: 'text',
            text: String(error && error.message ? error.message : error),
          },
        ],
        isError: true,
      });
    }
    return;
  }

  if (method === 'ping') {
    sendResult(id, {});
    return;
  }

  sendError(id, -32601, `Method not found: ${method}`);
}

function startStdioServer(runtime = createRuntime()) {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    try {
      const message = JSON.parse(trimmed);
      await handleMessage(runtime, message);
    } catch (error) {
      sendError(null, -32700, 'Parse error', {
        detail: String(error && error.message ? error.message : error),
      });
    }
  });
}

if (require.main === module) {
  startStdioServer();
}

module.exports = {
  INDEX_FILENAME,
  NOTE_TYPES,
  buildIndex,
  createRuntime,
  findOverlapHits,
  handleMessage,
  codexContinuityNoteUpdateApply,
  codexContinuityNoteUpdateDraft,
  codexContinuityOverlap,
  codexContinuitySessionContext,
  codexContinuitySessionDigest,
  codexContinuitySessionNoteDraft,
  codexContinuitySessionSearch,
  queryDocuments,
  startStdioServer,
};
