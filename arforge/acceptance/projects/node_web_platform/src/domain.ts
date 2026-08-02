export type WorkStatus = "open" | "closed";

export interface WorkItem {
  id: number;
  title: string;
  status: WorkStatus;
}

export function closeItem(item: WorkItem): WorkItem {
  return {...item, status: "closed"};
}
