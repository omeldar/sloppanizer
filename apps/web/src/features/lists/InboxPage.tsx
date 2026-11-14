import { PageHeader } from "../../components/ui.tsx";
import { TodoListView } from "./TodoListView.tsx";
import { hint } from "../../lib/device.ts";

export function InboxPage() {
  return (
    <>
      <PageHeader title="Inbox" />
      <TodoListView
        projectId="inbox"
        label="Inbox"
        empty={hint("Inbox is empty. Press c to add a todo.", "Inbox is empty. Tap + to add a todo.")}
      />
    </>
  );
}
