/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import Meta from 'gi://Meta';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const _handles = [];

export default class MaximizeToEmptyWorkspaceExtension extends Extension {
    constructor(metadata) {
        super(metadata);
    }

    _getMaximizeFlags(win) {
        return typeof win.get_maximize_flags === 'function'
            ? win.get_maximize_flags()
            : win.get_maximized();
    }

    _isApplicationWindow(win) {
        return win != null &&
            win.window_type === Meta.WindowType.NORMAL &&
            !win.is_always_on_all_workspaces();
    }

    _isProtected(win) {
        return this._getMaximizeFlags(win) === Meta.MaximizeFlags.BOTH ||
            win.is_fullscreen();
    }

    _getApplicationWindows(workspace, monitor, excludeWindow = null) {
        if (workspace == null)
            return [];

        return workspace.list_windows().filter(win =>
            win !== excludeWindow &&
            this._isApplicationWindow(win) &&
            win.get_monitor() === monitor
        );
    }

    _getWorkspaceApplications(manager, index, monitor, excludeWindow = null) {
        if (index < 0 || index >= manager.get_n_workspaces())
            return [];

        return this._getApplicationWindows(
            manager.get_workspace_by_index(index), monitor, excludeWindow
        );
    }

    _isWorkspaceAvailable(manager, index, monitor, excludeWindow = null) {
        return this._getWorkspaceApplications(
            manager, index, monitor, excludeWindow
        ).every(win => !this._isProtected(win));
    }

    _ensureWorkspace(manager, index, display) {
        while (manager.get_n_workspaces() <= index)
            manager.append_new_workspace(false, display.get_current_time());
    }

    _moveWindowToWorkspace(win, workspace) {
        if (workspace == null)
            return false;

        const currentWorkspace = win.get_workspace();
        if (currentWorkspace === workspace)
            return false;

        win.change_workspace_by_index(workspace.index(), false);
        return true;
    }

    /*
     * Build logical workspace groups for one monitor.
     *
     * A group keeps the actual Meta.Workspace object rather than its numeric
     * index. Normal applications sharing one workspace stay together.
     * Protected applications are split into individual groups.
     */
    _getMonitorGroups(monitor, display, excludeWindow = null) {
        const manager = display.get_workspace_manager();
        const groups = [];

        for (let index = 0; index < manager.get_n_workspaces(); index++) {
            const workspace = manager.get_workspace_by_index(index);
            const windows = this._getApplicationWindows(
                workspace, monitor, excludeWindow
            );

            if (windows.length === 0)
                continue;

            const normalWindows = windows.filter(win => !this._isProtected(win));
            const protectedWindows = windows.filter(win => this._isProtected(win));

            if (normalWindows.length > 0) {
                groups.push({
                    workspace,
                    windows: normalWindows,
                    protected: false,
                });
            }

            for (const win of protectedWindows) {
                groups.push({
                    workspace,
                    windows: [win],
                    protected: true,
                });
            }
        }

        return groups;
    }

    /*
     * Build a stable plan using workspace objects as both source and target.
     * Numeric indices are resolved only when a move is actually performed.
     */
    _buildCompactionPlan(groups, manager) {
        return groups.map((group, targetIndex) => ({
            sourceWorkspace: group.workspace,
            targetWorkspace: manager.get_workspace_by_index(targetIndex),
            windows: [...group.windows],
            protected: group.protected,
        }));
    }

    /*
     * Compact one monitor using a two-phase plan.
     *
     * Phase 1 isolates moving groups in dedicated temporary workspaces.
     * Phase 2 moves them to the planned target workspace objects.
     *
     * The plan never treats a numeric workspace index as a persistent
     * identity. This is important because workspace indices can change when
     * workspaces are added or removed.
     */
    _compactMonitor(monitor, display, excludeWindow = null) {
        const manager = display.get_workspace_manager();
        const groups = this._getMonitorGroups(monitor, display, excludeWindow);

        if (groups.length === 0) {
            this._removeTrailingEmptyWorkspaces(display);
            return;
        }

        const plan = this._buildCompactionPlan(groups, manager);
        const movingGroups = plan.filter(item =>
            item.windows.some(win => win.get_workspace() !== item.targetWorkspace)
        );

        if (movingGroups.length > 0) {
            const firstTemporaryIndex = manager.get_n_workspaces();
            for (let i = 0; i < movingGroups.length; i++)
                this._ensureWorkspace(manager, firstTemporaryIndex + i, display);

            const temporaryWorkspaces = [];
            for (let i = 0; i < movingGroups.length; i++) {
                temporaryWorkspaces.push(
                    manager.get_workspace_by_index(firstTemporaryIndex + i)
                );
            }

            // Phase 1: move each group to its own stable temporary workspace.
            movingGroups.forEach((item, offset) => {
                const temporaryWorkspace = temporaryWorkspaces[offset];
                item.windows.forEach(win =>
                    this._moveWindowToWorkspace(win, temporaryWorkspace)
                );
                item.temporaryWorkspace = temporaryWorkspace;
            });

            // Phase 2: resolve each target object's current index only now.
            movingGroups.forEach(item => {
                item.windows.forEach(win =>
                    this._moveWindowToWorkspace(win, item.targetWorkspace)
                );
            });
        }

        this._removeTrailingEmptyWorkspaces(display);
    }

    _removeTrailingEmptyWorkspaces(display) {
        const manager = display.get_workspace_manager();

        for (let i = manager.get_n_workspaces() - 1; i > 0; i--) {
            const workspace = manager.get_workspace_by_index(i);
            if (workspace.list_windows().length > 0)
                break;

            manager.remove_workspace(workspace, display.get_current_time());
        }
    }

    /*
     * Find the workspace immediately after the compacted monitor-local
     * sequence. This is called only after the other applications have been
     * compacted, so the destination is reserved from the final state rather
     * than inferred from the pre-compaction layout.
     */
    _findProtectedDestination(win) {
        const display = win.get_display();
        const manager = display.get_workspace_manager();
        const monitor = win.get_monitor();
        const groups = this._getMonitorGroups(monitor, display, win);
        const destinationIndex = groups.length;

        this._ensureWorkspace(manager, destinationIndex, display);
        return manager.get_workspace_by_index(destinationIndex);
    }

    _enterProtected(win) {
        if (!this._isApplicationWindow(win) || !this._isProtected(win))
            return;

        const display = win.get_display();
        const monitor = win.get_monitor();
        const workspace = win.get_workspace();

        // If this is the only application on its workspace, it may remain
        // there. We still compact other monitor-local groups if necessary.
        const applications = this._getApplicationWindows(workspace, monitor);
        if (applications.length <= 1) {
            this._compactMonitor(monitor, display, win);
            return;
        }

        // Compact the remaining applications first. Only after this step do
        // we determine and reserve the protected application's destination.
        this._compactMonitor(monitor, display, win);

        const destination = this._findProtectedDestination(win);
        this._moveWindowToWorkspace(win, destination);
        this._compactMonitor(monitor, display);
    }

    _findRestoreWorkspace(win) {
        const display = win.get_display();
        const manager = display.get_workspace_manager();
        const monitor = win.get_monitor();
        const current = win.get_workspace().index();

        // Strict priority: previous workspace first.
        const previous = current - 1;
        if (previous >= 0 && this._isWorkspaceAvailable(
            manager, previous, monitor, win
        )) {
            return manager.get_workspace_by_index(previous);
        }

        // Only inspect the following workspace if the previous is blocked.
        const next = current + 1;
        if (next < manager.get_n_workspaces() && this._isWorkspaceAvailable(
            manager, next, monitor, win
        )) {
            return manager.get_workspace_by_index(next);
        }

        return null;
    }

    _leaveProtected(win) {
        if (!this._isApplicationWindow(win) || this._isProtected(win))
            return;

        const display = win.get_display();
        const monitor = win.get_monitor();
        const destination = this._findRestoreWorkspace(win);

        if (destination != null)
            this._moveWindowToWorkspace(win, destination);

        this._compactMonitor(monitor, display);
    }

    _processTransition(win) {
        if (!this._isApplicationWindow(win))
            return;

        const currentProtected = this._isProtected(win);
        const previousProtected = this._windowStates.has(win)
            ? this._windowStates.get(win)
            : currentProtected;

        if (previousProtected === currentProtected)
            return;

        this._windowStates.set(win, currentProtected);

        this._runOperation(() => {
            if (currentProtected)
                this._enterProtected(win);
            else
                this._leaveProtected(win);
        });
    }

    _queueEvaluation(win) {
        if (!this._isApplicationWindow(win))
            return;

        this._pendingWindows.add(win);
        this._scheduleEvaluation();
    }

    _scheduleEvaluation() {
        if (this._operationInProgress || this._laterId !== 0)
            return;

        const laters = global.compositor.get_laters();
        this._laterId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;

            const windows = [...this._pendingWindows];
            this._pendingWindows.clear();
            windows.forEach(win => this._processTransition(win));
            return false;
        });
    }

    _runOperation(callback) {
        if (this._operationInProgress) {
            this._reevaluatePending = true;
            return;
        }

        this._operationInProgress = true;
        try {
            callback();
        } finally {
            this._operationInProgress = false;
        }

        if (this._reevaluatePending) {
            this._reevaluatePending = false;
            this._queueAllApplicationWindows();
        }
    }

    _queueAllApplicationWindows() {
        global.display.list_all_windows().forEach(win => {
            if (this._isApplicationWindow(win))
                this._pendingWindows.add(win);
        });

        this._scheduleEvaluation();
    }

    /*
     * Normalize the existing desktop before event-driven tracking begins.
     * This enforces the invariant that, for each monitor, application groups
     * are compacted from workspace 0 onward and any globally empty workspaces
     * are kept only at the end of the workspace list.
     */
    _initializeWorkspaceLayout() {
        const display = global.display;
        const monitors = new Set();

        display.list_all_windows().forEach(win => {
            if (this._isApplicationWindow(win))
                monitors.add(win.get_monitor());
        });

        monitors.forEach(monitor =>
            this._compactMonitor(monitor, display)
        );
    }

    enable() {
        this._windowStates = new Map();
        this._pendingWindows = new Set();
        this._laterId = 0;
        this._operationInProgress = false;
        this._reevaluatePending = false;

        _handles.push(global.window_manager.connect(
            'map', (_, act) => this.window_manager_map(act)
        ));
        _handles.push(global.window_manager.connect(
            'destroy', (_, act) => this.window_manager_destroy(act)
        ));
        _handles.push(global.window_manager.connect(
            'size-change', (_, act) => this.window_manager_size_change(act)
        ));
        _handles.push(global.window_manager.connect(
            'size-changed', (_, act) => this.window_manager_size_changed(act)
        ));

        // First normalize the existing layout. Only after normalization do
        // we record the real protected state of each application window.
        this._initializeWorkspaceLayout();

        global.display.list_all_windows().forEach(win => {
            if (this._isApplicationWindow(win))
                this._windowStates.set(win, this._isProtected(win));
        });
    }

    disable() {
        _handles.splice(0).forEach(handle =>
            global.window_manager.disconnect(handle)
        );

        if (this._laterId !== 0) {
            global.compositor.get_laters().remove(this._laterId);
            this._laterId = 0;
        }

        this._pendingWindows.clear();
        this._windowStates.clear();
        this._operationInProgress = false;
        this._reevaluatePending = false;
    }
}
