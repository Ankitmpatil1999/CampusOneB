/**
 * COM-025: the realtime channel is served by socket.io on `/realtime` (services/realtime.service.ts),
 * not by an Express route; this entry documents it in the OpenAPI document.
 */
import { defineRoute } from '../config/openapi-registry';

defineRoute({
  id: 'COM-025',
  method: 'get',
  path: '/realtime',
  summary:
    'Realtime channel (socket.io WebSocket upgrade): the access token in the handshake (`auth.token`) or the web session cookie (`auth.surface`); rooms come from the session only. Events carry identifiers: notification.created, payment.completed, payment.request.updated, wallet.credited, approval.created',
  tags: ['Realtime'],
  auth: 'member | console | ops',
  responses: { 101: { description: 'Switching protocols (WebSocket)' } },
});
