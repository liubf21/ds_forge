import React from "react";
import { Box, Text } from "ink";
import {
  formatToolCommand,
  formatToolStatus,
  truncateLine,
} from "./display.js";
import { fileUrl, linkText } from "./links.js";
import type { AssistantMessage } from "./types.js";

export function FileLink({
  path,
  label,
  dimColor = true,
}: {
  path: string;
  label?: string;
  dimColor?: boolean;
}) {
  const shown = label ?? path;
  return (
    <Text wrap="wrap" dimColor={dimColor}>
      {linkText(fileUrl(path), shown)}
    </Text>
  );
}

export function UserBubble({ content }: { content: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="cyan" bold>
        ❯ You
      </Text>
      <Text wrap="wrap">{content}</Text>
    </Box>
  );
}

function ToolBlockView({
  name,
  args,
  result,
  running,
}: {
  name: string;
  args: string;
  result?: string;
  running: boolean;
}) {
  const command = formatToolCommand(name, args);
  const status = formatToolStatus(result, running);
  return (
    <Box marginLeft={2} marginBottom={0}>
      <Text color="yellow" dimColor={running}>
        {running ? "◌ " : "⎿ "}
        <Text bold>{name}</Text>
        <Text color="gray"> ${truncateLine(command, 72)}</Text>
        {status && <Text dimColor> {status}</Text>}
      </Text>
    </Box>
  );
}

export function AssistantBubble({
  content,
  tools,
  streaming,
}: {
  content: string;
  tools: AssistantMessage["tools"];
  streaming?: boolean;
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="green" bold>
        ◆ Agent
      </Text>
      {tools.map((t) => (
        <ToolBlockView
          key={t.id}
          name={t.name}
          args={t.args}
          result={t.result}
          running={t.running}
        />
      ))}
      {(content || streaming) && (
        <Text wrap="wrap">
          {content}
          {streaming && <Text color="green">▊</Text>}
        </Text>
      )}
    </Box>
  );
}
