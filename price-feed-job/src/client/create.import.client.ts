import { ClientBuilder, type Client } from '@commercetools/ts-client';
import { createApiBuilderFromCtpClient } from '@commercetools/importapi-sdk';
import type { ByProjectKeyRequestBuilder } from '@commercetools/importapi-sdk';
import { readConfiguration } from '../utils/config.utils.js';

/**
 * The Import API is a SEPARATE service with its own host (`import.{region}.commercetools.com`) and its
 * own generated models (`@commercetools/importapi-sdk`). Same credentials, different client — a fact
 * that catches people out, because the types look almost identical to the platform SDK's and are not
 * interchangeable.
 */
let cached: ByProjectKeyRequestBuilder | undefined;

export function createImportApiRoot(): ByProjectKeyRequestBuilder {
  if (cached) return cached;
  const { projectKey, clientId, clientSecret, importUrl, authUrl, scopes } = readConfiguration();

  const client: Client = new ClientBuilder()
    .withProjectKey(projectKey)
    .withClientCredentialsFlow({
      host: authUrl,
      projectKey,
      credentials: { clientId, clientSecret },
      ...(scopes ? { scopes } : {}),
    })
    .withHttpMiddleware({ host: importUrl })
    .build();

  cached = createApiBuilderFromCtpClient(client).withProjectKeyValue({ projectKey });
  return cached;
}
