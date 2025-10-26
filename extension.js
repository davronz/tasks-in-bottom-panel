// extension.js - Tasks in Bottom Panel
// Combines panel positioning from Just Perfection with Tasks in Panel taskbar
// Based on Just Perfection by Javad Rahmatzadeh (GPL-3.0-only)
// Based on Tasks in Panel by @fthx
// https://gitlab.gnome.org/jrahmatzadeh/just-perfection

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import { AppMenu } from 'resource:///org/gnome/shell/ui/appMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const PANEL_POSITION = {
    TOP: 0,
    BOTTOM: 1,
};

const ICON_SIZE = 20; // px
const UNFOCUSED_OPACITY = 128; // 0...255

const TaskButton = GObject.registerClass(
    class TaskButton extends PanelMenu.Button {
        _init(window) {
            super._init();

            this._window = window;

            this.add_style_class_name('task-button');
            this._makeButtonBox();

            this._updateApp();
            this._updateVisibility();

            this._id = `task-button-${this._window}`;
            if (!Main.panel.statusArea[this._id])
                Main.panel.addToStatusArea(this._id, this, 99, 'left');

            this._connectSignals();
        }

        _connectSignals() {
            global.workspace_manager.connectObject('active-workspace-changed', () => this._updateVisibility(), this);

            this._window?.connectObject(
                'notify::appears-focused', () => this._updateFocus(), GObject.ConnectFlags.AFTER,
                'notify::demands-attention', () => this._updateDemandsAttention(), GObject.ConnectFlags.AFTER,
                'notify::gtk-application-id', () => this._updateApp(), GObject.ConnectFlags.AFTER,
                'notify::skip-taskbar', () => this._updateVisibility(), GObject.ConnectFlags.AFTER,
                'notify::urgent', () => this._updateDemandsAttention(), GObject.ConnectFlags.AFTER,
                'notify::wm-class', () => this._updateApp(), GObject.ConnectFlags.AFTER,
                'unmanaging', () => this.destroy(), GObject.ConnectFlags.AFTER,
                'workspace-changed', () => this._updateVisibility(), GObject.ConnectFlags.AFTER,
                this);

            this.connectObject(
                'notify::hover', () => this._onHover(),
                'button-press-event', (actor, event) => this._onClick(event),
                this);
        }

        _disconnectSignals() {
            global.workspace_manager.disconnectObject(this);

            this._window?.disconnectObject(this);
        }

        _makeButtonBox() {
            this._box = new St.BoxLayout();

            this._icon = new St.Icon({ fallback_gicon: null });
            this._box.add_child(this._icon);

            this.add_child(this._box);

            this.setMenu(new AppMenu(this));
        }

        _toggleWindow() {
            this._windowOnTop = null;

            if (this._window?.has_focus()) {
                if (this._window?.can_minimize() && !Main.overview.visible)
                    this._window?.minimize();
            } else {
                this._window?.activate(global.get_current_time());
                this._window?.focus(global.get_current_time());
            }
            Main.overview.hide();
        }

        _onClick(event) {
            const button = event?.get_button();

            if (button === Clutter.BUTTON_PRIMARY) {
                this.menu?.close();

                this._toggleWindow();

                return Clutter.EVENT_STOP;
            }

            if (button === Clutter.BUTTON_MIDDLE) {
                this.menu?.close();

                if (this._app?.can_open_new_window())
                    this._app?.open_new_window(-1);
                Main.overview.hide();

                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        }

        _onHover() {
            if (Main.overview.visible || !Main.wm._canScroll)
                return;

            if (this.get_hover()) {
                const monitorIndex = this._window?.get_monitor();
                const monitorWindows = this._window?.get_workspace()
                    .list_windows()
                    .filter(w => !w.minimized && w.get_monitor() === monitorIndex);
                this._windowOnTop = global.display.sort_windows_by_stacking(monitorWindows)?.at(-1);

                this._window?.raise();
            }
            else
                this._windowOnTop?.raise();
        }

        _updateWorkspace() {
            this._activeWorkspace = global.workspace_manager.get_active_workspace();
            this._windowIsOnActiveWorkspace = this._window?.located_on_workspace(this._activeWorkspace);
        }

        _updateFocus() {
            if (this._window?.appears_focused)
                this.opacity = 255;
            else
                this.opacity = UNFOCUSED_OPACITY;
        }

        _updateDemandsAttention() {
            if (this._window?.demands_attention) {
                this.opacity = 255;
                this.add_style_class_name('task-demands-attention');
                this.visible = true;
            } else {
                this.remove_style_class_name('task-demands-attention');
                this._updateVisibility();
            }
        }

        _updateApp() {
            if (this._window)
                this._app = Shell.WindowTracker.get_default().get_window_app(this._window);

            const wmClass = this._window?.wm_class;
            if (this._app) {
                if (wmClass?.startsWith('chrome'))
                    this._icon.set_gicon(Gio.Icon.new_for_string(wmClass));
                else
                    this._icon.set_gicon(this._app.icon);

                this.menu.setApp(this._app);
            }

            this._icon.set_icon_size(ICON_SIZE);
        }

        _updateVisibility() {
            this._updateFocus();
            this._updateWorkspace();

            this.visible = !this._window?.is_skip_taskbar() && this._windowIsOnActiveWorkspace;
        }

        destroy() {
            this._disconnectSignals();

            super.destroy();
        }
    });

const TaskBar = GObject.registerClass(
    class TaskBar extends GObject.Object {
        _init() {
            super._init();

            this._makeTaskbar();
        }

        _connectSignals() {
            global.display.connectObject('window-created', (display, window) => this._makeTaskButton(window), this);
            Main.panel.connectObject('scroll-event', (actor, event) => Main.wm.handleWorkspaceScroll(event), this);
        }

        _disconnectSignals() {
            global.display.disconnectObject(this);
            Main.panel.disconnectObject(this);
        }

        _makeTaskButton(window) {
            if (!window || window.is_skip_taskbar() || window.get_window_type() === Meta.WindowType.MODAL_DIALOG)
                return;

            new TaskButton(window);
        }

        _destroyTaskbar() {
            if (this._makeTaskbarTimeout) {
                GLib.Source.remove(this._makeTaskbarTimeout);
                this._makeTaskbarTimeout = null;
            }

            for (let bin of Main.panel._leftBox.get_children()) {
                const button = bin.child;

                if (button && button instanceof TaskButton)
                    button.destroy();
            }
        }

        _makeTaskbar() {
            this._makeTaskbarTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                const workspacesNumber = global.workspace_manager.n_workspaces;

                for (let workspaceIndex = 0; workspaceIndex < workspacesNumber; workspaceIndex++) {
                    const workspace = global.workspace_manager.get_workspace_by_index(workspaceIndex);
                    const windowsList = workspace?.list_windows() || [];

                    for (let window of windowsList)
                        this._makeTaskButton(window);
                }

                this._connectSignals();

                this._makeTaskbarTimeout = null;
                return GLib.SOURCE_REMOVE;
            });
        }

        destroy() {
            this._disconnectSignals();
            this._destroyTaskbar();
        }
    });

export default class TasksBottomPanelExtension extends Extension {
    enable() {
        this._panelPosition = PANEL_POSITION.TOP;
        this._workareasChangedSignal = null;
        this._panelHeightSignal = null;
        
        // Move panel to bottom (using Just Perfection's approach)
        this._panelSetPosition(PANEL_POSITION.BOTTOM);
        
        // Create taskbar (using Tasks in Panel's approach)
        this._taskbar = new TaskBar();
    }
    
    /**
     * Move panel position (from Just Perfection API.js)
     */
    _panelSetPosition(position, force = false) {
        let monitorInfo = this._monitorGetInfo();
        let panelBox = Main.layoutManager.panelBox;

        if (!force && position === this._panelPosition) {
            return;
        }

        if (position === PANEL_POSITION.TOP) {
            this._panelPosition = PANEL_POSITION.TOP;
            if (this._workareasChangedSignal) {
                global.display.disconnect(this._workareasChangedSignal);
                this._workareasChangedSignal = null;
            }
            if (this._panelHeightSignal) {
                panelBox.disconnect(this._panelHeightSignal);
                this._panelHeightSignal = null;
            }
            let topX = (monitorInfo) ? monitorInfo.x : 0;
            let topY = (monitorInfo) ? monitorInfo.y : 0;
            panelBox.set_position(topX, topY);
            this._fixPanelMenuSide(St.Side.TOP);
            return;
        }

        this._panelPosition = PANEL_POSITION.BOTTOM;

        if (monitorInfo) {
            let BottomX = monitorInfo.x;
            let BottomY = monitorInfo.y + monitorInfo.height - Main.panel.height;

            panelBox.set_position(BottomX, BottomY);
        }

        if (!this._workareasChangedSignal) {
            this._workareasChangedSignal = global.display.connect('workareas-changed', () => {
                this._panelSetPosition(PANEL_POSITION.BOTTOM, true);
            });
        }

        if (!this._panelHeightSignal) {
            this._panelHeightSignal = panelBox.connect('notify::height', () => {
                this._panelSetPosition(PANEL_POSITION.BOTTOM, true);
            });
        }

        this._fixPanelMenuSide(St.Side.BOTTOM);
    }

    _monitorGetInfo() {
        let pMonitor = Main.layoutManager.primaryMonitor;

        if (!pMonitor) {
            return false;
        }

        return {
            'x': pMonitor.x,
            'y': pMonitor.y,
            'width': pMonitor.width,
            'height': pMonitor.height,
            'geometryScale': pMonitor.geometry_scale,
        };
    }

    _fixPanelMenuSide(position) {
        let PanelMenuButton = PanelMenu.Button;
        let PanelMenuButtonProto = PanelMenuButton.prototype;

        let findPanelMenus = (widget) => {
            if (widget instanceof PanelMenuButton && widget.menu?._boxPointer) {
                widget.menu._boxPointer._userArrowSide = position;
            }
            widget.get_children().forEach(subWidget => {
                findPanelMenus(subWidget);
            });
        };

        let panelBoxes = [
            Main.panel._centerBox,
            Main.panel._rightBox,
            Main.panel._leftBox,
        ];
        panelBoxes.forEach(panelBox => findPanelMenus(panelBox));

        if (position === St.Side.TOP) {
            if (PanelMenuButtonProto._setMenuOld) {
                PanelMenuButtonProto.setMenu = PanelMenuButtonProto._setMenuOld;
            }
            return;
        }

        if (!PanelMenuButtonProto._setMenuOld) {
            PanelMenuButtonProto._setMenuOld = PanelMenuButtonProto.setMenu;
        }

        PanelMenuButtonProto.setMenu = function (menu) {
            this._setMenuOld(menu);
            if (menu) {
                menu._boxPointer._userArrowSide = position;
            }
        };
    }
    
    disable() {
        // Destroy taskbar first
        this._taskbar?.destroy();
        this._taskbar = null;
        
        // Restore panel position to top
        this._panelSetPosition(PANEL_POSITION.TOP);
        
        // Disconnect panel signals
        if (this._workareasChangedSignal) {
            global.display.disconnect(this._workareasChangedSignal);
            this._workareasChangedSignal = null;
        }
        if (this._panelHeightSignal) {
            Main.layoutManager.panelBox.disconnect(this._panelHeightSignal);
            this._panelHeightSignal = null;
        }
    }
}
