import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Panel from 'resource:///org/gnome/shell/ui/panel.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

const _origAddToPanelBox = Panel.Panel.prototype._addToPanelBox;

let timeout_id = null;
let settings = null;
let order_arr_left = null;
let order_arr_center = null;
let order_arr_right = null;
let blacklist_array = null;
let order_arr = null;

export default class OrderIcons extends Extension {
    enable() {
        settings = this.getSettings()
        order_arr_left = settings.get_value("order-icons-left").deep_unpack()
        order_arr_center = settings.get_value("order-icons-center").deep_unpack()
        order_arr_right = settings.get_value("order-icons-right").deep_unpack()
        blacklist_array = settings.get_value("icons-blacklist").deep_unpack()
        Panel.Panel.prototype._redrawIndicators = _redrawIndicators;
        Panel.Panel.prototype._addToPanelBox = _addToPanelBox;
        Main.panel._redrawIndicators();
        this.settingsIDs = [];
        this.settingsIDs.push(settings.connect('changed::order-icons-left', _ => {
            Main.panel._redrawIndicators()
        }));
        this.settingsIDs.push(settings.connect('changed::order-icons-center', _ => {
            Main.panel._redrawIndicators()
        }));
        this.settingsIDs.push(settings.connect('changed::order-icons-right', _ => {
            Main.panel._redrawIndicators()
        }));
        this.settingsIDs.push(settings.connect('changed::icons-blacklist', _ => {
            Main.panel._redrawIndicators()
        }));
    }

    disable() {
        Panel.Panel.prototype._redrawIndicators = undefined;
        Panel.Panel.prototype._addToPanelBox = _origAddToPanelBox;
        if (this.settingsIDs && settings) {
            this.settingsIDs.forEach(id => settings.disconnect(id));
        }
        if (timeout_id !== null) {
            GLib.Source.remove(timeout_id);
            timeout_id = null;
        }
        order_arr_left = null;
        order_arr_center = null;
        order_arr_right = null;
        blacklist_array = null;
        this.settingsIDs = null;
        settings = null;
    }
}



function _redrawIndicators() {
    order_arr_left = settings.get_value("order-icons-left").deep_unpack()
    order_arr_center = settings.get_value("order-icons-center").deep_unpack()
    order_arr_right = settings.get_value("order-icons-right").deep_unpack()
    blacklist_array = settings.get_value("icons-blacklist").deep_unpack()
    for (const k in this.statusArea) {
        const role = k;
        const indicator = this.statusArea[k];
        if (!indicator) continue;
        let parent = indicator.get_parent();
        if (!parent) continue;
        let box = parent.get_parent();
        if (box == undefined) continue
        this._addToPanelBox(role, indicator, 0, box)
    }

}


function _addToPanelBox(role, indicator, position, box) {

    const container = indicator.container;
    container.show();
    const parent = container.get_parent();
    if (parent) {
        parent.remove_child(container);
    }

    this.statusArea[role] = indicator;
    const statusArea = this.statusArea;
    const menuManager = this.menuManager;
    const onMenuSet = this._onMenuSet.bind(this);

    // not ideal, but due to recent changes in appindicator-extension we have to wait for the ID to become available
    waitForId(indicator, role).then(() => {
        let position_corr = getRelativePosition(indicator, role, box.name, statusArea);
        let testName = getTestName(indicator, role);
        if (blacklist_array.includes(testName)) {
            delete statusArea[role];
            return;
        }

        // Check if container or box have been disposed before inserting
        try {
            if (container && box && !container._disposed) {
                // Verify the container and box are still valid actors
                if (typeof container.get_parent === 'function' && typeof box.insert_child_at_index === 'function') {
                    setSettingValues(testName, box);
                    box.insert_child_at_index(container, position_corr ? position_corr : position);
                }
            }
        } catch (e) {
            // Container or box was disposed, skip insertion
            console.log(`OrderExtensions: Skipping disposed actor for ${role}: ${e.message}`);
            return;
        }

        if (indicator.menu) {
            menuManager.addMenu(indicator.menu);
        }
        const destroyId = indicator.connect('destroy', (emitter) => {
            delete statusArea[role];
            emitter.disconnect(destroyId);
        });
        indicator.connect('menu-set', onMenuSet);
        onMenuSet(indicator);
    }).catch((error) => { console.log(`OrderExtensions error: ${error}`) });
}


function setSettingValues(name, box) {
    let key = null;
    let arr = null;

    if (box.name == "panelRight") {
        key = "order-icons-right";
        arr = order_arr_right;
    } else if (box.name == "panelCenter") {
        key = "order-icons-center";
        arr = order_arr_center;
    } else if (box.name == "panelLeft") {
        key = "order-icons-left";
        arr = order_arr_left;
    }
    if (arr == null)
        return;

    // Only persist when the indicator is new. Writing unconditionally fires
    // changed::order-icons-* -> _redrawIndicators() -> _addToPanelBox() -> here
    // again, an endless loop that starves the shell's main loop (seen on GNOME 50).
    if (arr.includes(name))
        return;

    arr.splice(getSettingsPosition(name, arr), 0, name);
    settings.set_value(key, new GLib.Variant('as', arr));
}


function getRelativePosition(indicator, role, boxName, statusArea) {
    const indicatorTestName = getTestName(indicator, role);
    if (boxName == "panelRight")
        order_arr = order_arr_right
    else if (boxName == "panelCenter")
        order_arr = order_arr_center
    else if (boxName == "panelLeft")
        order_arr = order_arr_left
    const indicatorPosition = getSettingsPosition(indicatorTestName, order_arr);

    let ctr = 0
    for (const k in statusArea) {
        if (k == role) continue
        const item = statusArea[k];
        if (!item) continue;
        const itemParent = item.get_parent();
        if (!itemParent) continue;
        const itemBox = itemParent.get_parent();
        if (itemBox != null && boxName === itemBox.get_name()) {
            const toTest = getTestName(item, k);
            let setPosition = getSettingsPosition(toTest, order_arr);
            if (setPosition == null) {
                setPosition = 0;
            }
            if (setPosition < indicatorPosition) {
                ctr = ctr + 1;
            }

        }
    }
    return ctr
}


function until(conditionFunction) {
    const poll = resolve => {
        if (conditionFunction()) {
            resolve();
            return GLib.G_SOURCE_REMOVE;
        } else {
            timeout_id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, _ => poll(resolve));
            return GLib.G_SOURCE_REMOVE;
        }
    }
    return new Promise(poll);
}



function getTestName(indicator, name) {
    let toTest = name;
    if (indicator._indicator) {
        let id = indicator._indicator.id;
        if (name.startsWith('appindicator-')) {
            if (id.startsWith('chrome_status_icon')) {
                // electron apps don't give a good ID with newer releases, so we have to revert to command line and try to get something useful
                let commandLine = indicator._indicator._commandLine;
                let commandLineSplit = commandLine.split('/');
                toTest = commandLineSplit[commandLineSplit.length - 1];
            }
            else {
                toTest = id;
            }
        }
    }
    if (toTest) {
        const match = toTest.match(/appindicator-legacy:(.*?):/);
        if (match && match.length > 1) {
            return match[1];
        }
        if (toTest.includes('dropbox')) {
            // dropbox needs special treatment because it appends the pid to the id.
            // So we need to hardcode the name
            return 'dropbox';
        }
        return toTest;
    }
    let ret = name.split("/")
    return ret[ret.length - 1].replaceAll("_", "-")
}

async function waitForId(indicator, name) {
    if (indicator._indicator && name.startsWith('appindicator-')) {
        await until(_ => (indicator._indicator.id != undefined && indicator._indicator._commandLine != undefined));
    }
    return true
}

function getSettingsPosition(name, arr) {
    if (arr == null) {
        return 0;
    }
    let index = arr.indexOf(name);
    return index != -1 ? index : 0;
}
