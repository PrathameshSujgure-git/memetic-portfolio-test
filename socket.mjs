import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";

export function createSocketClient() {
  const socketClient = new SocketModeClient({
    appToken: process.env.SLACK_APP_TOKEN,
  });
  const webClient = new WebClient(process.env.SLACK_BOT_TOKEN);

  return { socketClient, webClient };
}
