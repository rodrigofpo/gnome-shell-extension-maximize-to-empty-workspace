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

    _moveWindowToWorkspace(win, index) {
        const manager = win.get_display().get_workspace_manager();
        if (index < 0 || index >= manager.get_n_workspaces())
            return false;

        if (win.get_workspace().index() === index)
            return false;

        win.change_workspace_by_index(index, false);
        return true;
    }

    /*
     * Build the logical workspace groups for one monitor.
     *
     * Normal windows belonging to the same workspace remain together.
     * Protected windows are split into individual groups, because a
     * maximized/fullscreen application must not share its workspace with
     * another application on the same monitor.
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

            if (normalWindows.length > 0)
                groups.push({index, windows: normalWindows, protected: false});

            for (const win of protectedWindows)
                groups.push({index, windows: [win], protected: true});
        }

        return groups;
    }

    /*
     * Compact one monitor without treating each normal window as a separate
     * workspace. Existing workspace groups retain their relative order.
     * Empty workspaces between groups disappear; only the trailing workspace
     * may remain empty.
     */
    _compactMonitor(monitor, display, excludeWindow = null) {
        const manager = display.get_workspace_manager();
        const groups = this._getMonitorGroups(monitor, display, excludeWindow);

        if (groups.length === 0) {
            this._removeTrailingEmptyWorkspaces(display);
            return;
        }

        const lastTarget = groups.length - 1;
        this._ensureWorkspace(manager, lastTarget, display);

        // Move groups from the end to the beginning. Windows in the same
        // normal group receive the same target workspace and therefore remain
        // together. Protected groups contain exactly one application.
        for (let target = groups.length - 1; target >= 0; target--) {
            const group = groups[target];
            for (const win of group.windows)
                this._moveWindowToWorkspace(win, target);
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

    _getLastOccupiedWorkspace(manager, monitor, excludeWindow = null) {
        for (let i = manager.get_n_workspaces() - 1; i >= 0; i--) {
            if (this._getWorkspaceApplications(
                manager, i, monitor, excludeWindow
            ).length > 0)
                return i;
        }
        return -1;
    }

    _findProtectedDestination(win) {
        const display = win.get_display();
        const manager = display.get_workspace_manager();
        const monitor = win.get_monitor();
        const current = win.get_workspace().index();
        const lastOccupied = this._getLastOccupiedWorkspace(manager, monitor, win);
        const destination = Math.max(current, lastOccupied) + 1;

        this._ensureWorkspace(manager, destination, display);
        return destination;
    }

    _enterProtected(win) {
        if (!this._isApplicationWindow(win) || !this._isProtected(win))
            return;

        const display = win.get_display();
        const monitor = win.get_monitor();
        const workspace = win.get_workspace();

        // This decision must be made before compaction changes workspace
        // membership. A protected window that was already alone may stay put.
        const applications = this._getApplicationWindows(workspace, monitor);
        if (applications.length <= 1) {
            this._compactMonitor(monitor, display);
            return;
        }

        // First compact normal workspace groups. The current workspace still
        // contains another application, so the protected window needs its own
        // workspace after the existing groups have been normalized.
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
            return previous;
        }

        // The following workspace is considered only when the previous one
        // is blocked by a protected application.
        const next = current + 1;
        if (next < manager.get_n_workspaces() && this._isWorkspaceAvailable(
            manager, next, monitor, win
        )) {
            return next;
        }

        return -1;
    }

    _leaveProtected(win) {
        if (!this._isApplicationWindow(win) || this._isProtected(win))
            return;

        const display = win.get_display();
        const monitor = win.get_monitor();
        const destination = this._findRestoreWorkspace(win);

        if (destination !== -1)
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

    window_manager_map(act) {
        const win = act.meta_window;
        if (!this._isApplicationWindow(win))
            return;

        this._windowStates.set(win, false);
        this._queueEvaluation(win);
    }

    window_manager_destroy(act) {
        const win = act.meta_window;
        this._pendingWindows.delete(win);
        this._windowStates.delete(win);

        const display = win.get_display();
        const monitor = win.get_monitor();

        this._runOperation(() => {
            this._compactMonitor(monitor, display);
        });
    }

    window_manager_size_change(act) {
        this._queueEvaluation(act.meta_window);
    }

    window_manager_size_changed(act) {
        this._queueEvaluation(act.meta_window);
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

        global.display.list_all_windows().forEach(win => {
            if (this._isApplicationWindow(win))
                this._windowStates.set(win, false);
        });

        this._queueAllApplicationWindows();
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
