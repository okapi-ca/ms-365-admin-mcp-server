#!/usr/bin/env node

import path from 'path';
import { fileURLToPath } from 'url';
import { downloadGraphOpenAPI, downloadGraphBetaOpenAPI } from './modules/download-openapi.mjs';
import { generateMcpTools } from './modules/generate-mcp-tools.mjs';
import { createAndSaveSimplifiedOpenAPI } from './modules/simplified-openapi.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const openapiDir = path.join(rootDir, 'openapi');
const srcDir = path.join(rootDir, 'src');

const openapiFile = path.join(openapiDir, 'openapi.yaml');
const openapiBetaFile = path.join(openapiDir, 'openapi-beta.yaml');
const openapiTrimmedFile = path.join(openapiDir, 'openapi-trimmed.yaml');
const endpointsFile = path.join(srcDir, 'endpoints.json');

const generatedDir = path.join(srcDir, 'generated');

const args = process.argv.slice(2);
const forceDownload = args.includes('--force');

async function main() {
  console.log('Microsoft Graph API OpenAPI Processor');
  console.log('------------------------------------');

  try {
    console.log('\n📥 Step 1a: Downloading v1.0 OpenAPI specification');
    const v1Downloaded = await downloadGraphOpenAPI(
      openapiDir,
      openapiFile,
      undefined,
      forceDownload
    );
    console.log(v1Downloaded ? '✅ v1.0 spec downloaded' : '⏭️  v1.0 spec already present');

    console.log('\n📥 Step 1b: Downloading beta OpenAPI specification');
    const betaDownloaded = await downloadGraphBetaOpenAPI(
      openapiDir,
      openapiBetaFile,
      forceDownload
    );
    console.log(betaDownloaded ? '✅ beta spec downloaded' : '⏭️  beta spec already present');

    console.log('\n🔧 Step 2: Creating simplified OpenAPI specification');
    createAndSaveSimplifiedOpenAPI(endpointsFile, openapiFile, openapiTrimmedFile, openapiBetaFile);
    console.log('✅ Successfully created simplified OpenAPI specification');

    console.log('\n🚀 Step 3: Generating client code using openapi-zod-client');
    generateMcpTools(null, generatedDir);
    console.log('✅ Successfully generated client code');
  } catch (error) {
    console.error('\n❌ Error processing OpenAPI specification:', error.message);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
