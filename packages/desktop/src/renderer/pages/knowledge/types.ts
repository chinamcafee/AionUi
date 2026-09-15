// E-23：知识库四能力共享类型（对齐 KE-v2 web 端 src/app/types.ts，仅 UI 层消费）

export interface KnowledgeDoc {
  id: string;
  title: string;
  docType: 'native' | 'upload';
  content?: string;
  updatedAt?: string;
  createdAt?: string;
}

export interface OrganizerItem {
  id: string;
  name: string;
  description?: string;
  color: string;
  version?: number;
  documentCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface OrganizerDocument {
  id: string;
  title: string;
  docType: 'native' | 'upload';
  owner?: string;
  visibility?: string;
  updatedAt?: string;
  groups?: Array<{ id: string; name: string; color: string }>;
  tags?: Array<{ id: string; name: string; color: string }>;
}

export interface GraphNode {
  id: string;
  title: string;
  type: string;
  description?: string;
  frequency?: number;
  degree?: number;
  communityIds?: string[];
  docIds?: string[];
}

export interface GraphLink {
  from: string;
  to: string;
  description?: string;
  weight: number;
}

export interface GraphCommunity {
  id: string;
  title: string;
  level?: number;
  size?: number | null;
}

export interface GraphSubgraph {
  count?: number;
  nodes: GraphNode[];
  links: GraphLink[];
  communities: GraphCommunity[];
}

export interface GraphStats {
  entities: number;
  relationships: number;
  communities: number;
  reports: number;
}

export interface GraphReport {
  id: string;
  title: string;
  summary?: string;
  rank?: number;
  community?: string;
}

export interface TeamGraphSummary {
  documents?: number;
  completedJobs?: number;
  pendingJobs?: number;
  failedJobs?: number;
  rebuildStatus?: string;
}

export interface TeamKnowledgeDocument {
  id: string;
  filename?: string;
  title?: string;
  mime?: string;
  visibility: 'personal' | 'team' | string;
  visibilityStatus?: string;
  classification?: string;
  status?: string;
  version?: number;
  owner?: string;
  jobId?: string;
  jobStatus?: string;
  jobFailureCode?: string | null;
  createdAt?: string;
  updatedAt?: string;
}
