/**
 * `workspaceRegistry` domain (L2) — `IWorkspaceQueryService` implementation.
 *
 * Combines the explicit workspace catalog with active sessions from
 * `sessionIndex`. Resolves workspace aliases through their normalized root,
 * falls back from legacy sessions without `cwd` to the registered root, and
 * excludes archived sessions from workspace counts and recent-session lists.
 * Bound at App scope.
 */

import { basename } from 'pathe';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { encodeWorkDirKey, normalizeWorkDir } from '#/_base/utils/workdir-slug';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';

import {
  IWorkspaceRegistry,
  type Workspace,
  type WorkspaceRegistrySnapshot,
} from './workspaceRegistry';
import {
  IWorkspaceQueryService,
  RECENT_SESSIONS_LIMIT,
  type WorkspaceListItem,
} from './workspaceQuery';

export class WorkspaceQueryService implements IWorkspaceQueryService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWorkspaceRegistry private readonly registry: IWorkspaceRegistry,
    @ISessionIndex private readonly index: ISessionIndex,
  ) {}

  async list(): Promise<readonly WorkspaceListItem[]> {
    const [snapshot, page] = await Promise.all([
      this.registry.snapshot(),
      this.index.list({}),
    ]);
    const deletedRoots = normalizedDeletedRoots(snapshot);
    const byRoot = new Map<
      string,
      { workspace: WorkspaceListItem; registered: boolean; canonical: boolean }
    >();

    for (const workspace of snapshot.workspaces) {
      const root = normalizeWorkDir(workspace.root);
      if (isDeleted(snapshot, workspace.id, root, deletedRoots)) continue;
      const canonicalId = encodeWorkDirKey(root);
      const candidate: WorkspaceListItem = {
        ...workspace,
        id: canonicalId,
        root,
        sessionCount: 0,
      };
      const existing = byRoot.get(root);
      const canonical = workspace.id === canonicalId;
      if (existing === undefined || (!existing.canonical && canonical)) {
        byRoot.set(root, { workspace: candidate, registered: true, canonical });
      }
    }

    for (const session of page.items) {
      const root = sessionRoot(session, snapshot);
      if (root === undefined || isDeleted(snapshot, session.workspaceId, root, deletedRoots)) {
        continue;
      }
      const existing = byRoot.get(root);
      if (existing === undefined) {
        byRoot.set(root, {
          workspace: {
            id: encodeWorkDirKey(root),
            root,
            name: basename(root),
            createdAt: finiteTimestamp(session.createdAt),
            lastOpenedAt: finiteTimestamp(session.updatedAt),
            sessionCount: 1,
          },
          registered: false,
          canonical: true,
        });
        continue;
      }
      const workspace = existing.workspace;
      byRoot.set(root, {
        ...existing,
        workspace: {
          ...workspace,
          createdAt: existing.registered
            ? workspace.createdAt
            : Math.min(workspace.createdAt, finiteTimestamp(session.createdAt)),
          lastOpenedAt: existing.registered
            ? workspace.lastOpenedAt
            : Math.max(workspace.lastOpenedAt, finiteTimestamp(session.updatedAt)),
          sessionCount: workspace.sessionCount + 1,
        },
      });
    }

    return [...byRoot.values()]
      .map(({ workspace }) => workspace)
      .toSorted((left, right) =>
        right.lastOpenedAt - left.lastOpenedAt || left.id.localeCompare(right.id),
      );
  }

  async get(workspaceId: string): Promise<Workspace | undefined> {
    const snapshot = await this.registry.snapshot();
    const registered = resolveRegisteredWorkspace(snapshot, workspaceId);
    if (registered !== undefined) return registered;

    const page = await this.index.list({ includeArchived: true });
    const sessions = sessionsForWorkspace(page.items, snapshot, workspaceId);
    return deriveWorkspace(sessions, snapshot);
  }

  async listSessions(
    workspaceId: string,
    options?: { readonly includeArchived?: boolean },
  ): Promise<readonly SessionSummary[]> {
    const snapshot = await this.registry.snapshot();
    const page = await this.index.list({ includeArchived: options?.includeArchived });
    return sessionsForWorkspace(page.items, snapshot, workspaceId).toSorted(
      (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id),
    );
  }

  async countActiveSessions(workspaceId: string): Promise<number> {
    return (await this.listSessions(workspaceId)).length;
  }

  async listRecentSessions(workspaceId: string): Promise<readonly SessionSummary[]> {
    return (await this.listSessions(workspaceId)).slice(0, RECENT_SESSIONS_LIMIT);
  }
}

function resolveRegisteredWorkspace(
  snapshot: WorkspaceRegistrySnapshot,
  workspaceId: string,
): Workspace | undefined {
  if (snapshot.deletedWorkspaceIds.has(workspaceId)) return undefined;
  const workspace =
    snapshot.workspaces.find((candidate) => candidate.id === workspaceId) ??
    snapshot.workspaces.find(
      (candidate) => encodeWorkDirKey(normalizeWorkDir(candidate.root)) === workspaceId,
    );
  if (workspace === undefined) return undefined;
  const root = normalizeWorkDir(workspace.root);
  if (normalizedDeletedRoots(snapshot).has(root)) return undefined;
  return { ...workspace, id: encodeWorkDirKey(root), root };
}

function sessionsForWorkspace(
  sessions: readonly SessionSummary[],
  snapshot: WorkspaceRegistrySnapshot,
  workspaceId: string,
): SessionSummary[] {
  const registered = resolveRegisteredWorkspace(snapshot, workspaceId);
  const requestedRoot = registered?.root;
  const deletedRoots = normalizedDeletedRoots(snapshot);
  if (snapshot.deletedWorkspaceIds.has(workspaceId)) return [];
  return sessions.filter((session) => {
    const root = sessionRoot(session, snapshot);
    if (root === undefined || isDeleted(snapshot, session.workspaceId, root, deletedRoots)) {
      return false;
    }
    if (requestedRoot !== undefined) return root === requestedRoot;
    return session.workspaceId === workspaceId || encodeWorkDirKey(root) === workspaceId;
  });
}

function sessionRoot(
  session: SessionSummary,
  snapshot: WorkspaceRegistrySnapshot,
): string | undefined {
  if (session.cwd !== undefined && session.cwd.trim() !== '') {
    return normalizeWorkDir(session.cwd);
  }
  const registered = snapshot.workspaces.find(
    (workspace) => workspace.id === session.workspaceId,
  ) ??
    snapshot.workspaces.find(
      (workspace) => encodeWorkDirKey(normalizeWorkDir(workspace.root)) === session.workspaceId,
    );
  return registered === undefined ? undefined : normalizeWorkDir(registered.root);
}

function deriveWorkspace(
  sessions: readonly SessionSummary[],
  snapshot: WorkspaceRegistrySnapshot,
): Workspace | undefined {
  if (sessions.length === 0) return undefined;
  const root = sessions
    .map((session) => sessionRoot(session, snapshot))
    .find((candidate): candidate is string => candidate !== undefined);
  if (root === undefined) return undefined;
  return {
    id: encodeWorkDirKey(root),
    root,
    name: basename(root),
    createdAt: Math.min(...sessions.map((session) => finiteTimestamp(session.createdAt))),
    lastOpenedAt: Math.max(...sessions.map((session) => finiteTimestamp(session.updatedAt))),
  };
}

function normalizedDeletedRoots(snapshot: WorkspaceRegistrySnapshot): ReadonlySet<string> {
  const roots = new Set(
    [...snapshot.deletedWorkspaceRoots.values()].map((root) => normalizeWorkDir(root)),
  );
  for (const workspace of snapshot.workspaces) {
    if (snapshot.deletedWorkspaceIds.has(workspace.id)) {
      roots.add(normalizeWorkDir(workspace.root));
    }
  }
  return roots;
}

function isDeleted(
  snapshot: WorkspaceRegistrySnapshot,
  workspaceId: string,
  root: string,
  deletedRoots: ReadonlySet<string>,
): boolean {
  return snapshot.deletedWorkspaceIds.has(workspaceId) || deletedRoots.has(root);
}

function finiteTimestamp(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

registerScopedService(
  LifecycleScope.App,
  IWorkspaceQueryService,
  WorkspaceQueryService,
  InstantiationType.Delayed,
  'workspaceRegistry',
);
