import { ClientBuilder, type Client } from '@commercetools/ts-client';
import { createApiBuilderFromCtpClient } from '@commercetools/platform-sdk';
import type { ByProjectKeyRequestBuilder } from '@commercetools/platform-sdk';
import { readConfiguration } from '../utils/config.utils.js';

/**
 * The commercetools client.
 *
 * The credentials are NOT asked for at install time. `connect.yaml` declares
 * `inheritAs.apiClient.scopes`, so Connect generates an API Client holding exactly those scopes and
 * injects CTP_CLIENT_ID / CTP_CLIENT_SECRET / CTP_SCOPE / CTP_PROJECT_KEY / CTP_API_URL / CTP_AUTH_URL
 * at runtime. Nobody pastes a `manage_project` secret into a form, and nobody can.
 */
let cached: ByProjectKeyRequestBuilder | undefined;

export function createApiRoot(): ByProjectKeyRequestBuilder {
  if (cached) return cached;
  const { projectKey, clientId, clientSecret, apiUrl, authUrl, scopes } = readConfiguration();

  const client: Client = new ClientBuilder()
    .withProjectKey(projectKey)
    .withClientCredentialsFlow({
      host: authUrl,
      projectKey,
      credentials: { clientId, clientSecret },
      ...(scopes ? { scopes } : {}),
    })
    .withHttpMiddleware({ host: apiUrl })
    .build();

  cached = createApiBuilderFromCtpClient(client).withProjectKey({ projectKey });
  return cached;
}
