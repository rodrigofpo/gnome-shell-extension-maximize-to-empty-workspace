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
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import Meta from 'gi://Meta';
import Gio from 'gi://Gio';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const _handles = [];

const _windowids_maximized = new Map();
const _windowids_size_change = new Map();

export default class MaximizeToEmptyWorkspaceExtension extends Extension {
    constructor(metadata) {
        super(metadata);
    }

    // Compatibility shim: Meta.Window.get_maximized() was removed in
    // GNOME Shell 49, replaced by get_maximize_flags(). Feature-detect
    // so this keeps working on older and newer GNOME Shell versions.
    _getMaximizeFlags(win) {
        return typeof win.get_maximize_flags === 'function'
            ? win.get_maximize_flags()
            : win.get_maximized();
    }

    // First free workspace on the specified monitor.
    getFirstFreeMonitor(manager, mMonitor) {
        const n = manager.get_n_workspaces();
        for (let i = 0; i < n; i++) {
            const winCount = manager.get_workspace_by_index(i).list_windows()
                .filter(w => !w.is_always_on_all_workspaces() && w.get_monitor() === mMonitor).length;
            if (winCount < 1)
                return i;
        }
        return -1;
    }

    // Last occupied workspace on the specified monitor.
    getLastOccupiedMonitor(manager, nCurrent, mMonitor) {
        for (let i = nCurrent - 1; i >= 0; i--) {
            const winCount = manager.get_workspace_by_index(i).list_windows()
                .filter(w => !w.is_always_on_all_workspaces() && w.get_monitor() === mMonitor).length;
            if (winCount > 0)
                return i;
        }
        const n = manager.get_n_workspaces();
        for (let i = nCurrent + 1; i < n; i++) {
            const winCount = manager.get_workspace_by_index(i).list_windows()
                .filter(w => !w.is_always_on_all_workspaces() && w.get_monitor() === mMonitor).length;
            if (winCount > 0)
                return i;
        }
        return -1;
    }

    placeOnWorkspace(win) {
        // Do not move the corresponding window itself; it may not be fully
        // active yet. Reorder the workspaces and move the other windows.
        const mMonitor = win.get_monitor();
        const wList = win.get_workspace().list_windows()
            .filter(w => w !== win && !w.is_always_on_all_workspaces() && w.get_monitor() === mMonitor);

        if (wList.length >= 1) {
            const manager = win.get_display().get_workspace_manager();
            // Use the window's workspace, not the globally active workspace.
            // This keeps the extension independent for each monitor.
            const current = win.get_workspace().index();

            if (this._mutterSettings.get_boolean('workspaces-only-on-primary')) {
                const mPrimary = win.get_display().get_primary_monitor();
                // Only the primary monitor has multiple independent workspaces
                // when this Mutter setting is enabled.
                if (mMonitor !== mPrimary)
                    return;

                const firstfree = this.getFirstFreeMonitor(manager, mMonitor);
                if (firstfree === -1)
                    return;

                if (current < firstfree) {
                    manager.reorder_workspace(manager.get_workspace_by_index(firstfree), current);
                    wList.forEach(w => w.change_workspace_by_index(current, false));
                    _windowids_maximized.set(win.get_id(), 'reorder');
                } else if (current > firstfree) {
                    manager.reorder_workspace(manager.get_workspace_by_index(current), firstfree);
                    manager.reorder_workspace(manager.get_workspace_by_index(firstfree + 1), current);
                    wList.forEach(w => w.change_workspace_by_index(current, false));
                    _windowids_maximized.set(win.get_id(), 'reorder');
                }
            } else {
                // All monitors have workspaces. Search for a free workspace
                // on this monitor only.
                const firstfree = this.getFirstFreeMonitor(manager, mMonitor);
                if (firstfree === -1)
                    return;

                const wListcurrent = win.get_workspace().list_windows()
                    .filter(w => w !== win && !w.is_always_on_all_workspaces());
                const wListfirstfree = manager.get_workspace_by_index(firstfree).list_windows()
                    .filter(w => w !== win && !w.is_always_on_all_workspaces());

                if (current < firstfree) {
                    manager.reorder_workspace(manager.get_workspace_by_index(firstfree), current);
                    manager.reorder_workspace(manager.get_workspace_by_index(current + 1), firstfree);
                    wListcurrent.forEach(w => w.change_workspace_by_index(current, false));
                    wListfirstfree.forEach(w => w.change_workspace_by_index(firstfree, false));
                    _windowids_maximized.set(win.get_id(), 'reorder');
                } else if (current > firstfree) {
                    manager.reorder_workspace(manager.get_workspace_by_index(current), firstfree);
                    manager.reorder_workspace(manager.get_workspace_by_index(firstfree + 1), current);
                    wListcurrent.forEach(w => w.change_workspace_by_index(current, false));
                    wListfirstfree.forEach(w => w.change_workspace_by_index(firstfree, false));
                    _windowids_maximized.set(win.get_id(), 'reorder');
                }
            }
        }
    }

    // Back to the last occupied workspace.
    backto(win) {
        if (!_windowids_maximized.has(win.get_id()))
            return;

        _windowids_maximized.delete(win.get_id());

        const mMonitor = win.get_monitor();
        const wList = win.get_workspace().list_windows()
            .filter(w => w !== win && !w.is_always_on_all_workspaces() && w.get_monitor() === mMonitor);

        if (wList.length === 0) {
            const manager = win.get_display().get_workspace_manager();
            // Use the window's workspace, not the globally active workspace.
            const current = win.get_workspace().index();

            if (this._mutterSettings.get_boolean('workspaces-only-on-primary')) {
                const mPrimary = win.get_display().get_primary_monitor();
                if (mMonitor !== mPrimary)
                    return;

                const lastOccupied = this.getLastOccupiedMonitor(manager, current, mMonitor);
                if (lastOccupied === -1)
                    return;

                const wListLastOccupied = manager.get_workspace_by_index(lastOccupied).list_windows()
                    .filter(w => w !== win && !w.is_always_on_all_workspaces() && w.get_monitor() === mMonitor);
                manager.reorder_workspace(manager.get_workspace_by_index(current), lastOccupied);
                wListLastOccupied.forEach(w => w.change_workspace_by_index(lastOccupied, false));
            } else {
                const lastOccupied = this.getLastOccupiedMonitor(manager, current, mMonitor);
                if (lastOccupied === -1)
                    return;

                const wListCurrent = win.get_workspace().list_windows()
                    .filter(w => w !== win && !w.is_always_on_all_workspaces());
                if (wListCurrent.length > 0)
                    return;

                const wListLastOccupied = manager.get_workspace_by_index(lastOccupied).list_windows()
                    .filter(w => w !== win && !w.is_always_on_all_workspaces());
                manager.reorder_workspace(manager.get_workspace_by_index(current), lastOccupied);
                wListLastOccupied.forEach(w => w.change_workspace_by_index(lastOccupied, false));
            }
        }
    }

    window_manager_map(act) {
        const win = act.meta_window;
        if (win.window_type !== Meta.WindowType.NORMAL)
            return;
        if (this._getMaximizeFlags(win) !== Meta.MaximizeFlags.BOTH)
            return;
        if (win.is_always_on_all_workspaces())
            return;
        this.placeOnWorkspace(win);
    }

    window_manager_destroy(act) {
        const win = act.meta_window;
        _windowids_size_change.delete(win.get_id());
        if (win.window_type !== Meta.WindowType.NORMAL)
            return;
        this.backto(win);
    }

    window_manager_size_change(act, change, rectold) {
        const win = act.meta_window;
        if (win.window_type !== Meta.WindowType.NORMAL)
            return;
        if (win.is_always_on_all_workspaces())
            return;

        if (change === Meta.SizeChange.MAXIMIZE) {
            if (this._getMaximizeFlags(win) === Meta.MaximizeFlags.BOTH)
                _windowids_size_change.set(win.get_id(), 'place');
        } else if (change === Meta.SizeChange.FULLSCREEN) {
            _windowids_size_change.set(win.get_id(), 'place');
        } else if (change === Meta.SizeChange.UNMAXIMIZE) {
            // Do nothing if it was only partially maximized.
            const rectmax = win.get_work_area_for_monitor(win.get_monitor());
            if (rectmax.equal(rectold))
                _windowids_size_change.set(win.get_id(), 'back');
        } else if (change === Meta.SizeChange.UNFULLSCREEN) {
            if (this._getMaximizeFlags(win) !== Meta.MaximizeFlags.BOTH)
                _windowids_size_change.set(win.get_id(), 'back');
        }
    }

    window_manager_minimize(act) {
        const win = act.meta_window;
        if (win.window_type !== Meta.WindowType.NORMAL)
            return;
        if (win.is_always_on_all_workspaces())
            return;
        this.backto(win);
    }

    window_manager_unminimize(act) {
        const win = act.meta_window;
        if (win.window_type !== Meta.WindowType.NORMAL)
            return;
        if (this._getMaximizeFlags(win) !== Meta.MaximizeFlags.BOTH)
            return;
        if (win.is_always_on_all_workspaces())
            return;
        this.placeOnWorkspace(win);
    }

    window_manager_size_changed(act) {
        const win = act.meta_window;
        if (_windowids_size_change.has(win.get_id())) {
            if (_windowids_size_change.get(win.get_id()) === 'place')
                this.placeOnWorkspace(win);
            else if (_windowids_size_change.get(win.get_id()) === 'back')
                this.backto(win);
            _windowids_size_change.delete(win.get_id());
        }
    }

    enable() {
        this._mutterSettings = new Gio.Settings({schema_id: 'org.gnome.mutter'});
        _handles.push(global.window_manager.connect('minimize', (_, act) => {this.window_manager_minimize(act);}));
        _handles.push(global.window_manager.connect('unminimize', (_, act) => {this.window_manager_unminimize(act);}));
        _handles.push(global.window_manager.connect('size-changed', (_, act) => {this.window_manager_size_changed(act);}));
        _handles.push(global.window_manager.connect('map', (_, act) => {this.window_manager_map(act);}));
        _handles.push(global.window_manager.connect('destroy', (_, act) => {this.window_manager_destroy(act);}));
        _handles.push(global.window_manager.connect('size-change', (_, act, change, rectold) => {this.window_manager_size_change(act, change, rectold);}));
    }

    disable() {
        _handles.splice(0).forEach(h => global.window_manager.disconnect(h));
        _windowids_maximized.clear();
        _windowids_size_change.clear();
        this._mutterSettings = null;
    }
}