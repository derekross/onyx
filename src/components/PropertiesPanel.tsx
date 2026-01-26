import { Component, For, Show, createSignal, createEffect } from 'solid-js';
import { parseFrontmatter, serializeFrontmatter, FrontmatterProperty } from '../lib/frontmatter';

interface PropertiesPanelProps {
  content: string | null;
  onUpdateContent: (newContent: string) => void;
  onClose: () => void;
}

// Property type icons
const typeIcons: Record<FrontmatterProperty['type'], string> = {
  text: 'T',
  list: '[]',
  boolean: '?',
  number: '#',
  date: '📅',
  unknown: '?',
};

const PropertiesPanel: Component<PropertiesPanelProps> = (props) => {
  const [properties, setProperties] = createSignal<FrontmatterProperty[]>([]);
  const [newPropertyKey, setNewPropertyKey] = createSignal('');
  const [editingKey, setEditingKey] = createSignal<string | null>(null);
  const [editingValue, setEditingValue] = createSignal<string>('');

  // Parse frontmatter when content changes
  createEffect(() => {
    const content = props.content;
    if (!content) {
      setProperties([]);
      return;
    }
    const parsed = parseFrontmatter(content);
    setProperties(parsed?.properties || []);
  });

  // Convert value to display string
  const valueToString = (value: FrontmatterProperty['value']): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
  };

  // Parse string input to appropriate value type
  const parseValue = (input: string, currentType: FrontmatterProperty['type']): FrontmatterProperty['value'] => {
    const trimmed = input.trim();
    
    // Empty input
    if (!trimmed) return null;
    
    // Boolean
    if (trimmed.toLowerCase() === 'true') return true;
    if (trimmed.toLowerCase() === 'false') return false;
    
    // Number
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      return parseFloat(trimmed);
    }
    
    // List (comma-separated)
    if (trimmed.includes(',') || currentType === 'list') {
      return trimmed.split(',').map(s => s.trim()).filter(s => s);
    }
    
    // Plain text
    return trimmed;
  };

  // Update a property value
  const updateProperty = (key: string, newValue: string) => {
    const currentProps = properties();
    const prop = currentProps.find(p => p.key === key);
    if (!prop) return;

    const parsedValue = parseValue(newValue, prop.type);
    const newType = inferType(parsedValue);
    
    const updatedProps = currentProps.map(p => 
      p.key === key ? { ...p, value: parsedValue, type: newType } : p
    );
    
    applyChanges(updatedProps);
    setEditingKey(null);
  };

  // Infer type from value (same logic as frontmatter.ts)
  const inferType = (value: unknown): FrontmatterProperty['type'] => {
    if (value === null || value === undefined) return 'unknown';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'number') return 'number';
    if (Array.isArray(value)) return 'list';
    if (typeof value === 'string') {
      if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(value)) return 'date';
      return 'text';
    }
    return 'unknown';
  };

  // Delete a property
  const deleteProperty = (key: string) => {
    const updatedProps = properties().filter(p => p.key !== key);
    applyChanges(updatedProps);
  };

  // Add a new property
  const addProperty = () => {
    const key = newPropertyKey().trim();
    if (!key) return;
    
    // Check for duplicate
    if (properties().some(p => p.key === key)) {
      setNewPropertyKey('');
      return;
    }
    
    const newProp: FrontmatterProperty = {
      key,
      value: '',
      type: 'text',
    };
    
    const updatedProps = [...properties(), newProp];
    applyChanges(updatedProps);
    setNewPropertyKey('');
    
    // Start editing the new property
    setEditingKey(key);
    setEditingValue('');
  };

  // Apply changes to the document
  const applyChanges = (updatedProps: FrontmatterProperty[]) => {
    const content = props.content;
    if (!content) return;
    
    const parsed = parseFrontmatter(content);
    const newFrontmatter = serializeFrontmatter(updatedProps);
    
    let newContent: string;
    if (parsed) {
      // Replace existing frontmatter
      const lines = content.split('\n');
      const afterFrontmatter = lines.slice(parsed.endLine + 1).join('\n');
      
      if (updatedProps.length === 0) {
        // Remove frontmatter entirely
        newContent = afterFrontmatter.replace(/^\n+/, '');
      } else {
        newContent = newFrontmatter + '\n' + afterFrontmatter;
      }
    } else {
      // Add new frontmatter at the beginning
      if (updatedProps.length === 0) {
        newContent = content;
      } else {
        newContent = newFrontmatter + '\n\n' + content;
      }
    }
    
    setProperties(updatedProps);
    props.onUpdateContent(newContent);
  };

  // Handle key press in new property input
  const handleNewPropertyKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addProperty();
    }
  };

  // Handle key press in editing value input
  const handleEditKeyDown = (e: KeyboardEvent, key: string) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      updateProperty(key, editingValue());
    } else if (e.key === 'Escape') {
      setEditingKey(null);
    }
  };

  // Start editing a property
  const startEditing = (prop: FrontmatterProperty) => {
    setEditingKey(prop.key);
    setEditingValue(valueToString(prop.value));
  };

  return (
    <div class="properties-panel">
      <div class="properties-header">
        <span class="properties-header-title">Properties</span>
        <button class="properties-close" onClick={props.onClose} title="Close">×</button>
      </div>

      <div class="properties-content">
        <Show when={props.content} fallback={<div class="properties-empty">No file open</div>}>
          {/* Property List */}
          <div class="properties-list">
            <For each={properties()}>
              {(prop) => (
                <div class="property-item">
                  <div class="property-key">
                    <span class="property-type-icon" title={prop.type}>
                      {typeIcons[prop.type]}
                    </span>
                    <span class="property-key-text">{prop.key}</span>
                  </div>
                  <div class="property-value-row">
                    <Show 
                      when={editingKey() === prop.key}
                      fallback={
                        <div 
                          class="property-value" 
                          onClick={() => startEditing(prop)}
                          title="Click to edit"
                        >
                          {valueToString(prop.value) || <span class="property-empty">empty</span>}
                        </div>
                      }
                    >
                      <input
                        type="text"
                        class="property-value-input"
                        value={editingValue()}
                        onInput={(e) => setEditingValue(e.currentTarget.value)}
                        onKeyDown={(e) => handleEditKeyDown(e, prop.key)}
                        onBlur={() => updateProperty(prop.key, editingValue())}
                        autofocus
                        placeholder="Enter value..."
                      />
                    </Show>
                    <button 
                      class="property-delete" 
                      onClick={() => deleteProperty(prop.key)}
                      title="Delete property"
                    >
                      ×
                    </button>
                  </div>
                </div>
              )}
            </For>
          </div>

          {/* Add Property */}
          <div class="property-add">
            <input
              type="text"
              placeholder="Add property..."
              value={newPropertyKey()}
              onInput={(e) => setNewPropertyKey(e.currentTarget.value)}
              onKeyDown={handleNewPropertyKeyDown}
            />
            <button 
              class="property-add-btn" 
              onClick={addProperty}
              disabled={!newPropertyKey().trim()}
            >
              +
            </button>
          </div>

          {/* Empty state */}
          <Show when={properties().length === 0}>
            <div class="properties-hint">
              Add properties to organize your notes with metadata like tags, dates, and custom fields.
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
};

export default PropertiesPanel;
