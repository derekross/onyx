import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';

export const taskPluginKey = new PluginKey('task');

// Regex to match completion date suffix: ✅ YYYY-MM-DD
const COMPLETION_DATE_REGEX = / ✅ \d{4}-\d{2}-\d{2}$/;

// Get today's date in YYYY-MM-DD format
function getTodayDate(): string {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Create the ProseMirror plugin for task checkboxes
export const taskPlugin = $prose((_ctx) => {
  return new Plugin({
    key: taskPluginKey,

    props: {
      handleClick(view, _pos, event) {
        const target = event.target as HTMLElement;

        // Find the task list item - could be the target or a parent
        const taskItem = target.closest('li[data-item-type="task"]') as HTMLElement | null;

        if (!taskItem) {
          return false;
        }

        // Check if clicked on the checkbox area (left side of the item)
        // We'll consider clicks on the ::before pseudo-element area
        const rect = taskItem.getBoundingClientRect();
        const clickX = event.clientX - rect.left;

        // Only toggle if clicked in the first 30px (checkbox area)
        if (clickX > 30) {
          return false;
        }

        event.preventDefault();

        // Get current checked state from the DOM attribute
        const isCurrentlyChecked = taskItem.getAttribute('data-checked') === 'true';
        const newCheckedState = !isCurrentlyChecked;

        // Find the node position in the document
        const { state, dispatch } = view;
        const { doc, tr } = state;

        // Find the list item node at or near this position
        let taskNodePos: number | null = null;
        let taskNode: any = null;

        doc.descendants((node, nodePos) => {
          if (taskNodePos !== null) return false; // Already found

          // Check if this is a list_item with task type
          if (node.type.name === 'list_item' && node.attrs.checked !== undefined) {
            // Check if this node contains our click position
            const domNode = view.nodeDOM(nodePos);
            if (domNode === taskItem || (domNode as Element)?.contains?.(taskItem)) {
              taskNodePos = nodePos;
              taskNode = node;
              return false;
            }
          }
          return true;
        });

        if (taskNodePos === null || !taskNode) {
          return false;
        }

        // Create transaction to update the checked attribute
        tr.setNodeMarkup(taskNodePos, undefined, {
          ...taskNode.attrs,
          checked: newCheckedState,
        });

        // Now handle the completion date in the text content
        // We need to find text nodes within this list item and modify them
        const nodeEnd: number = taskNodePos + (taskNode.nodeSize as number);

        // Find text content within the task item
        let textNodePos: number | null = null;
        let textNode: any = null;

        doc.nodesBetween(taskNodePos, nodeEnd, (node, pos) => {
          if (node.isText && textNode === null) {
            textNodePos = pos;
            textNode = node;
          }
        });

        if (textNodePos !== null && textNode) {
          const currentText: string = textNode.text || '';
          const textLen = currentText.length;

          if (newCheckedState) {
            // Adding completion - append date if not already present
            if (!COMPLETION_DATE_REGEX.test(currentText)) {
              const newText = `${currentText} ✅ ${getTodayDate()}`;
              tr.insertText(newText, textNodePos, textNodePos + textLen);
            }
          } else {
            // Removing completion - strip the date suffix
            if (COMPLETION_DATE_REGEX.test(currentText)) {
              const newText = currentText.replace(COMPLETION_DATE_REGEX, '');
              tr.insertText(newText, textNodePos, textNodePos + textLen);
            }
          }
        }

        dispatch(tr);
        return true;
      },
    },
  });
});
