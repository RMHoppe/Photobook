// sidebar-right.ts — Re-exports all right-sidebar panel classes.
// Import from this file so that existing consumers don't need to know the split.

export type { ProjectSettingsData } from './sidebar-project-settings.js';
export type { SpreadSettingsData }  from './sidebar-spread-settings.js';
export { BoxModelEditor }        from './sidebar-box-model.js';
export { ProjectSettingsPanel }  from './sidebar-project-settings.js';
export { SpreadSettingsPanel }   from './sidebar-spread-settings.js';
export { TextElementEditor }     from './sidebar-text-editor.js';
export { SidebarPhotoInfoPanel } from './sidebar-photo-info.js';
