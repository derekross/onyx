/**
 * Frontmatter parsing and manipulation
 * 
 * Handles YAML frontmatter in markdown files (the --- delimited section at the top)
 */

export interface FrontmatterProperty {
  key: string;
  value: string | string[] | boolean | number | null;
  type: 'text' | 'list' | 'boolean' | 'number' | 'date' | 'unknown';
}

export interface ParsedFrontmatter {
  properties: FrontmatterProperty[];
  raw: string;
  startLine: number;
  endLine: number;
}

/**
 * Check if a value looks like a date string
 */
function isDateString(value: string): boolean {
  // ISO date: 2024-01-15 or 2024-01-15T10:30:00
  const isoPattern = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/;
  return isoPattern.test(value);
}

/**
 * Infer the type of a frontmatter value
 */
function inferType(value: unknown): FrontmatterProperty['type'] {
  if (value === null || value === undefined) return 'unknown';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'string') {
    if (isDateString(value)) return 'date';
    return 'text';
  }
  return 'unknown';
}

/**
 * Parse YAML frontmatter from markdown content
 * Returns null if no valid frontmatter found
 */
export function parseFrontmatter(content: string): ParsedFrontmatter | null {
  const lines = content.split('\n');
  
  // Must start with ---
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return null;
  }
  
  // Find closing ---
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIndex = i;
      break;
    }
  }
  
  if (endIndex === -1) {
    return null;
  }
  
  const yamlLines = lines.slice(1, endIndex);
  const raw = yamlLines.join('\n');
  
  // Simple YAML parsing (handles common cases)
  const properties: FrontmatterProperty[] = [];
  let currentKey: string | null = null;
  let currentValue: string | string[] | null = null;
  let inMultilineList = false;
  
  for (const line of yamlLines) {
    // Skip empty lines and comments
    if (line.trim() === '' || line.trim().startsWith('#')) {
      continue;
    }
    
    // List item (- value)
    if (line.match(/^\s+-\s+/)) {
      if (currentKey && inMultilineList) {
        const itemValue = line.replace(/^\s+-\s+/, '').trim();
        if (!Array.isArray(currentValue)) {
          currentValue = [];
        }
        currentValue.push(itemValue);
      }
      continue;
    }
    
    // Key: value pair
    const match = line.match(/^(\w[\w\s-]*?):\s*(.*)$/);
    if (match) {
      // Save previous property if exists
      if (currentKey !== null) {
        properties.push({
          key: currentKey,
          value: currentValue,
          type: inferType(currentValue)
        });
      }
      
      currentKey = match[1].trim();
      const rawValue = match[2].trim();
      
      // Check for inline list: [item1, item2]
      if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
        const listContent = rawValue.slice(1, -1);
        currentValue = listContent.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
        inMultilineList = false;
      }
      // Check for start of multiline list
      else if (rawValue === '') {
        currentValue = [];
        inMultilineList = true;
      }
      // Boolean values
      else if (rawValue === 'true') {
        currentValue = true as unknown as string;
        inMultilineList = false;
      }
      else if (rawValue === 'false') {
        currentValue = false as unknown as string;
        inMultilineList = false;
      }
      // Number values
      else if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
        currentValue = parseFloat(rawValue) as unknown as string;
        inMultilineList = false;
      }
      // Quoted string
      else if ((rawValue.startsWith('"') && rawValue.endsWith('"')) ||
               (rawValue.startsWith("'") && rawValue.endsWith("'"))) {
        currentValue = rawValue.slice(1, -1);
        inMultilineList = false;
      }
      // Plain string
      else {
        currentValue = rawValue;
        inMultilineList = false;
      }
    }
  }
  
  // Save last property
  if (currentKey !== null) {
    properties.push({
      key: currentKey,
      value: currentValue,
      type: inferType(currentValue)
    });
  }
  
  return {
    properties,
    raw,
    startLine: 0,
    endLine: endIndex
  };
}

/**
 * Serialize frontmatter properties back to YAML
 */
export function serializeFrontmatter(properties: FrontmatterProperty[]): string {
  if (properties.length === 0) {
    return '';
  }
  
  const lines: string[] = ['---'];
  
  for (const prop of properties) {
    if (prop.value === null || prop.value === undefined) {
      lines.push(`${prop.key}:`);
    } else if (Array.isArray(prop.value)) {
      if (prop.value.length === 0) {
        lines.push(`${prop.key}: []`);
      } else if (prop.value.length <= 3 && prop.value.every(v => !v.includes(','))) {
        // Inline format for short lists
        lines.push(`${prop.key}: [${prop.value.join(', ')}]`);
      } else {
        // Multiline format
        lines.push(`${prop.key}:`);
        for (const item of prop.value) {
          lines.push(`  - ${item}`);
        }
      }
    } else if (typeof prop.value === 'boolean') {
      lines.push(`${prop.key}: ${prop.value}`);
    } else if (typeof prop.value === 'number') {
      lines.push(`${prop.key}: ${prop.value}`);
    } else {
      // String - quote if contains special characters
      const needsQuotes = /[:#\[\]{}|>&*!?]/.test(prop.value as string) || 
                         (prop.value as string).includes('\n');
      if (needsQuotes) {
        lines.push(`${prop.key}: "${(prop.value as string).replace(/"/g, '\\"')}"`);
      } else {
        lines.push(`${prop.key}: ${prop.value}`);
      }
    }
  }
  
  lines.push('---');
  return lines.join('\n');
}

/**
 * Update frontmatter in document content
 * Returns new content with updated frontmatter
 */
export function updateFrontmatter(
  content: string,
  properties: FrontmatterProperty[]
): string {
  const parsed = parseFrontmatter(content);
  const newFrontmatter = serializeFrontmatter(properties);
  
  if (parsed) {
    // Replace existing frontmatter
    const lines = content.split('\n');
    const afterFrontmatter = lines.slice(parsed.endLine + 1).join('\n');
    
    if (properties.length === 0) {
      // Remove frontmatter entirely
      return afterFrontmatter.replace(/^\n+/, '');
    }
    
    return newFrontmatter + '\n' + afterFrontmatter;
  } else {
    // Add new frontmatter at the beginning
    if (properties.length === 0) {
      return content;
    }
    return newFrontmatter + '\n\n' + content;
  }
}

/**
 * Add or update a single property
 */
export function setProperty(
  content: string,
  key: string,
  value: string | string[] | boolean | number | null
): string {
  const parsed = parseFrontmatter(content);
  const properties = parsed?.properties || [];
  
  // Find existing property
  const existingIndex = properties.findIndex(p => p.key === key);
  
  if (value === null || value === undefined) {
    // Remove property
    if (existingIndex >= 0) {
      properties.splice(existingIndex, 1);
    }
  } else {
    const newProp: FrontmatterProperty = {
      key,
      value,
      type: inferType(value)
    };
    
    if (existingIndex >= 0) {
      properties[existingIndex] = newProp;
    } else {
      properties.push(newProp);
    }
  }
  
  return updateFrontmatter(content, properties);
}

/**
 * Get a single property value
 */
export function getProperty(
  content: string,
  key: string
): string | string[] | boolean | number | null {
  const parsed = parseFrontmatter(content);
  if (!parsed) return null;
  
  const prop = parsed.properties.find(p => p.key === key);
  return prop?.value ?? null;
}

/**
 * Remove a property
 */
export function removeProperty(content: string, key: string): string {
  return setProperty(content, key, null);
}
