import { PageHeader } from "../../components/ui.tsx";
import { TodoListView } from "./TodoListView.tsx";

export function InboxPage() {
  return (
    <>
      <PageHeader title="Inbox" />
      <TodoListView projectId="inbox" label="Inbox" empty="Inbox is empty. Press c to add a todo." />
    </>
  );
}
