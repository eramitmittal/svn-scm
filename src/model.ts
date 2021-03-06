import {
  workspace,
  Uri,
  window,
  Disposable,
  WorkspaceFoldersChangeEvent
} from "vscode";
import * as fs from "fs";
import * as path from "path";
import { Repository } from "./repository";
import { Svn } from "./svn";
import { dispose, anyEvent, filterEvent } from "./util";

interface OpenRepository {
  repository: Repository;
}

export class Model {
  public openRepositories: OpenRepository[] = [];
  private disposables: Disposable[] = [];
  private enabled = false;
  private possibleSvnRepositoryPaths = new Set<string>();

  get repositories(): Repository[] {
    return this.openRepositories.map(r => r.repository);
  }

  constructor(private svn: Svn) {
    const config = workspace.getConfiguration("svn");
    this.enabled = config.get("enabled") === true;

    if (this.enabled) {
      this.init();
    } else {
      this.disable();
    }
  }

  private init(): void {
    workspace.onDidChangeWorkspaceFolders(
      this.onDidChangeWorkspaceFolders,
      this,
      this.disposables
    );
    this.onDidChangeWorkspaceFolders({
      added: workspace.workspaceFolders || [],
      removed: []
    });

    const fsWatcher = workspace.createFileSystemWatcher("**");
    this.disposables.push(fsWatcher);

    const onWorkspaceChange = anyEvent(
      fsWatcher.onDidChange,
      fsWatcher.onDidCreate,
      fsWatcher.onDidDelete
    );
    const onPossibleSvnRepositoryChange = filterEvent(
      onWorkspaceChange,
      uri => !this.getRepository(uri)
    );
    onPossibleSvnRepositoryChange(
      this.onPossibleSvnRepositoryChange,
      this,
      this.disposables
    );

    this.scanWorkspaceFolders();
  }

  private onPossibleSvnRepositoryChange(uri: Uri): void {
    const possibleSvnRepositoryPath = uri.fsPath.replace(/\.svn.*$/, "");
    this.possibleSvnRepositoryPaths.add(possibleSvnRepositoryPath);
    this.eventuallyScanPossibleSvnRepositories();
  }

  private eventuallyScanPossibleSvnRepositories(): void {
    for (const path of this.possibleSvnRepositoryPaths) {
      this.tryOpenRepository(path);
    }

    this.possibleSvnRepositoryPaths.clear();
  }

  private disable(): void {
    this.repositories.forEach(repository => repository.dispose());
    this.openRepositories = [];
    this.disposables = dispose(this.disposables);
  }

  private onDidChangeWorkspaceFolders({
    added,
    removed
  }: WorkspaceFoldersChangeEvent) {
    const possibleRepositoryFolders = added.filter(
      folder => !this.getOpenRepository(folder.uri)
    );

    const openRepositoriesToDispose = removed
      .map(folder => this.getOpenRepository(folder.uri.fsPath))
      .filter(repository => !!repository)
      .filter(
        repository =>
          !(workspace.workspaceFolders || []).some(f =>
            repository!.repository.root.startsWith(f.uri.fsPath)
          )
      ) as OpenRepository[];

    possibleRepositoryFolders.forEach(p =>
      this.tryOpenRepository(p.uri.fsPath)
    );
    openRepositoriesToDispose.forEach(r => r.repository.dispose());
  }

  private async scanWorkspaceFolders() {
    for (const folder of workspace.workspaceFolders || []) {
      const root = folder.uri.fsPath;
      this.tryOpenRepository(root);
    }
  }

  async tryOpenRepository(path: string): Promise<void> {
    if (this.getRepository(path)) {
      return;
    }

    try {
      const repositoryRoot = await this.svn.getRepositoryRoot(path);

      if (this.getRepository(repositoryRoot)) {
        return;
      }

      const repository = new Repository(this.svn.open(repositoryRoot, path));

      this.open(repository);
    } catch (err) {
      console.error(err);
      return;
    }
  }

  getRepository(hint: any) {
    const liveRepository = this.getOpenRepository(hint);
    return liveRepository && liveRepository.repository;
  }

  getOpenRepository(hint: any): OpenRepository | undefined {
    if (!hint) {
      return undefined;
    }

    if (hint instanceof Repository) {
      return this.openRepositories.filter(r => r.repository === hint)[0];
    }

    if (typeof hint === "string") {
      hint = Uri.file(hint);
    }

    if (hint instanceof Uri) {
      for (const liveRepository of this.openRepositories) {
        const relativePath = path.relative(
          liveRepository.repository.root,
          hint.fsPath
        );

        if (!/^\.\./.test(relativePath)) {
          return liveRepository;
        }
      }

      return undefined;
    }

    for (const liveRepository of this.openRepositories) {
      const repository = liveRepository.repository;

      if (hint === repository.sourceControl) {
        return liveRepository;
      }

      if (hint === repository.changes || hint === repository.notTracked) {
        return liveRepository;
      }
    }

    return undefined;
  }

  private open(repository: Repository): void {
    this.openRepositories.push({ repository });
  }

  async pickRepository() {
    if (this.openRepositories.length === 0) {
      throw new Error("There are no available repositories");
    }

    const picks: any[] = this.openRepositories.map(repository => {
      return {
        label: path.basename(repository.repository.root),
        repository: repository
      };
    });
    const placeHolder = "Choose a repository";
    const pick = await window.showQuickPick(picks, { placeHolder });

    return pick && pick.repository;
  }

  dispose(): void {}
}
