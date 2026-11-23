import { type AiProvider, CLAUDE_MODELS, type ClaudeModel } from "@organizer/shared";
import { type FormEvent, useState } from "react";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { Button, Field, TextInput } from "../../components/ui.tsx";
import { testOllama, useAiSettings, useUpdateAiSettings } from "../../lib/ai.ts";
import { errorMessage } from "../../lib/api.ts";
import styles from "./Settings.module.css";
import { TimeInput } from "../../components/DateTimeInputs.tsx";

const PROVIDERS: { value: AiProvider; name: string; note: string }[] = [
  { value: "none", name: "Off", note: "A plain todo app, no AI." },
  {
    value: "claude",
    name: "Claude",
    note: "Works on every device. Needs your Anthropic API key; each request costs a little.",
  },
  {
    value: "ollama",
    name: "Local model (Ollama)",
    note: "Free and private, runs on this computer. Works only in this browser on this machine.",
  },
];

const MODEL_NAMES: Record<ClaudeModel, string> = {
  "claude-opus-5-5": "Claude Opus 5.5 (best plans)",
  "claude-sonnet-5-5": "Claude Sonnet 5.5 (cheaper)",
  "claude-haiku-5-5": "Claude Haiku 5.5 (cheapest, fastest)",
};

/** Which AI plans the day and breaks todos down: off, Claude through the server, or Ollama on this machine. */
export function AiAssistantSection() {
  const settings = useAiSettings();
  const update = useUpdateAiSettings();
  const toast = useToast();
  const [key, setKey] = useState("");
  const [test, setTest] = useState<string | null>(null);
  const data = settings.data;
  if (!data) return null;

  const save = (patch: Parameters<typeof update.mutate>[0], message = "Saved the AI settings") =>
    update.mutate(patch, {
      onSuccess: () => toast.show({ message }),
      onError: (error) => toast.show({ tone: "error", message: errorMessage(error) }),
    });

  const saveKey = (event: FormEvent) => {
    event.preventDefault();
    if (!key.trim()) return;
    save({ claudeApiKey: key.trim() }, "Saved the Claude API key");
    setKey("");
  };

  return (
    <section className={styles.section} aria-labelledby="ai-heading">
      <h2 className={styles.heading} id="ai-heading">
        AI assistant
      </h2>
      <p className={styles.text}>
        Plans your day in the planner and splits big todos into steps. Everything it proposes waits for your
        OK; without it Sloppanizer stays a plain todo list.
      </p>
      <div className={styles.aiProviders} role="radiogroup" aria-label="AI provider">
        {PROVIDERS.map((p) => (
          <label key={p.value} className={styles.aiCard} data-on={data.provider === p.value || undefined}>
            <input
              type="radio"
              name="ai-provider"
              checked={data.provider === p.value}
              onChange={() => save({ provider: p.value })}
            />
            <span className={styles.themeName}>{p.name}</span>
            <span className={styles.aiCardNote}>{p.note}</span>
          </label>
        ))}
      </div>

      {data.provider === "claude" && (
        <div className={styles.aiFields}>
          <form className={styles.aiRow} onSubmit={saveKey}>
            <Field
              label={
                data.claudeKeySet ? "API key (saved; enter a new one to replace it)" : "Anthropic API key"
              }
            >
              <TextInput
                type="password"
                autoComplete="off"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder={data.claudeKeySet ? "••••••••" : "sk-ant-..."}
              />
            </Field>
            <Button type="submit" disabled={!key.trim() || update.isPending}>
              Save key
            </Button>
            {data.claudeKeySet && (
              <Button
                variant="ghost"
                onClick={() => save({ claudeApiKey: "" }, "Removed the Claude API key")}
              >
                Remove
              </Button>
            )}
          </form>
          <Field label="Model">
            <select
              className={styles.aiSelect}
              value={data.claudeModel}
              onChange={(event) => save({ claudeModel: event.target.value as ClaudeModel })}
            >
              {CLAUDE_MODELS.map((m) => (
                <option key={m} value={m}>
                  {MODEL_NAMES[m]}
                </option>
              ))}
            </select>
          </Field>
          <p className={styles.note}>
            Get a key at console.anthropic.com. It is stored encrypted on the server and never shown again.
          </p>
        </div>
      )}

      {data.provider === "ollama" && (
        <div className={styles.aiFields}>
          <OllamaFields
            url={data.ollamaUrl}
            model={data.ollamaModel}
            onSave={(ollamaUrl, ollamaModel) => save({ ollamaUrl, ollamaModel })}
            onTest={async (url, model) => setTest(await testOllama(url, model))}
          />
          {test && <p className={styles.note}>{test}</p>}
          <p className={styles.note}>
            Ollama must accept this site: set OLLAMA_ORIGINS={window.location.origin} for Ollama and restart
            it. The browser may ask to allow access to devices on your network.
          </p>
        </div>
      )}

      {data.provider !== "none" && (
        <div className={styles.aiRow}>
          <Field label="Working day from">
            <TimeInput
              step={900}
              value={data.dayStart}
              onChange={(value) => value && value !== data.dayStart && save({ dayStart: value })}
            />
          </Field>
          <Field label="to">
            <TimeInput
              step={900}
              value={data.dayEnd}
              onChange={(value) => value && value !== data.dayEnd && save({ dayEnd: value })}
            />
          </Field>
        </div>
      )}
    </section>
  );
}

function OllamaFields({
  url,
  model,
  onSave,
  onTest,
}: {
  url: string;
  model: string;
  onSave: (url: string, model: string) => void;
  onTest: (url: string, model: string) => Promise<void>;
}) {
  const [draftUrl, setDraftUrl] = useState(url);
  const [draftModel, setDraftModel] = useState(model);
  const [testing, setTesting] = useState(false);
  return (
    <form
      className={styles.aiRow}
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draftUrl.trim(), draftModel.trim());
      }}
    >
      <Field label="Ollama address">
        <TextInput value={draftUrl} onChange={(event) => setDraftUrl(event.target.value)} />
      </Field>
      <Field label="Model">
        <TextInput value={draftModel} onChange={(event) => setDraftModel(event.target.value)} />
      </Field>
      <Button type="submit" disabled={draftUrl === url && draftModel === model}>
        Save
      </Button>
      <Button
        variant="ghost"
        disabled={testing}
        onClick={() => {
          setTesting(true);
          void onTest(draftUrl.trim(), draftModel.trim()).finally(() => setTesting(false));
        }}
      >
        {testing ? "Testing" : "Test connection"}
      </Button>
    </form>
  );
}
