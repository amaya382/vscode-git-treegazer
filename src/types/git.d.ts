/**
 * Minimal type definitions for VSCode's built-in Git extension API.
 * Extracted from https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
 */

import { Uri, Event, Disposable } from "vscode";

export interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: Event<boolean>;
  getAPI(version: 1): API;
}

export interface API {
  readonly repositories: Repository[];
  readonly onDidOpenRepository: Event<Repository>;
  readonly onDidCloseRepository: Event<Repository>;
  getRepository(uri: Uri): Repository | null;
  openRepository(uri: Uri): Promise<Repository | null>;
}

export interface Repository {
  readonly rootUri: Uri;
}
