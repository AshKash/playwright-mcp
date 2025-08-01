/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { Context } from './context.js';
import { snapshotTools, visionTools } from './tools.js';
import { packageJSON } from './package.js';

import { FullConfig, validateConfig } from './config.js';

import type { BrowserContextFactory } from './browserContextFactory.js';

export function createConnection(config: FullConfig, browserContextFactory: BrowserContextFactory): Connection {
  const allTools = config.vision ? visionTools : snapshotTools;
  // Enable all tools by default if no capabilities are specified
  const tools = config.capabilities && config.capabilities.length > 0 
    ? allTools.filter(tool => tool.capability === 'core' || config.capabilities!.includes(tool.capability))
    : allTools; // Use all tools when no capabilities specified
  validateConfig(config);
  const context = new Context(tools, config, browserContextFactory);
  const server = new McpServer({ name: 'Playwright', version: packageJSON.version }, {
    capabilities: {
      tools: {},
    }
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: tools.map(tool => ({
        name: tool.schema.name,
        description: tool.schema.description,
        inputSchema: zodToJsonSchema(tool.schema.inputSchema),
        annotations: {
          title: tool.schema.title,
          readOnlyHint: tool.schema.type === 'readOnly',
          destructiveHint: tool.schema.type === 'destructive',
          openWorldHint: true,
        },
      })) as McpTool[],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const errorResult = (...messages: string[]) => ({
      content: [{ type: 'text', text: messages.join('\n') }],
      isError: true,
    });
    const tool = tools.find(tool => tool.schema.name === request.params.name);
    if (!tool)
      return errorResult(`Tool "${request.params.name}" not found`);


    const modalStates = context.modalStates().map(state => state.type);
    if (tool.clearsModalState && !modalStates.includes(tool.clearsModalState))
      return errorResult(`The tool "${request.params.name}" can only be used when there is related modal state present.`, ...context.modalStatesMarkdown());
    if (!tool.clearsModalState && modalStates.length)
      return errorResult(`Tool "${request.params.name}" does not handle the modal state.`, ...context.modalStatesMarkdown());

    try {
      return await context.run(tool, request.params.arguments);
    } catch (error) {
      return errorResult(String(error));
    }
  });

  return new Connection(server, context);
}

export class Connection {
  readonly server: McpServer;
  readonly context: Context;

  constructor(server: McpServer, context: Context) {
    this.server = server;
    this.context = context;
    this.server.oninitialized = () => {
      this.context.clientVersion = this.server.getClientVersion();
    };
  }

  async close() {
    await this.server.close();
    // Only close the context if keepBrowserOpen is not enabled
    if (!this.context.config.keepBrowserOpen) {
      await this.context.close();
    }
  }
}
