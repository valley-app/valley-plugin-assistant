import { React } from '../runtime'
import { uiText } from '../localization'

export interface SlashCommand {
  id: string
  label: string
  description: string
  run(): void
}

export function SlashMenu({ commands, selected, onSelect }: { commands: SlashCommand[]; selected: number; onSelect(command: SlashCommand): void }) {
  return <div className="assistant-slash-menu" id="assistant-slash-menu" role="listbox" aria-label={uiText('assistant.slash.title')}>
    {commands.map((command, index) => <button type="button" role="option" id={`assistant-slash-${command.id}`} key={command.id} aria-selected={index === selected}
      onMouseDown={event => event.preventDefault()} onClick={() => onSelect(command)}>
      <span>{command.label}</span><span>{command.description}</span>
    </button>)}
  </div>
}
