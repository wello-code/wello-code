# Встроенные скиллы Wello Code

Это локальный плагин Claude Code (`.claude-plugin/plugin.json` + `skills/*/SKILL.md`),
который поставляется вместе с приложением и подгружается в каждый запуск агента.

- Папка копируется в portable-сборку скриптом `apps/desktop/scripts/package-win.mjs`
  (в `resources/app/skills-bundle`) и резолвится в рантайме через
  `apps/desktop/src/main/bundled-skills.ts`.
- Какие скиллы активны — определяется тумблерами в **Настройки → «Скиллы»**
  (`AppSettings.bundledSkills`); движку передаётся явный список `Options.skills`,
  поэтому посторонние скиллы с машины пользователя не подмешиваются.
- Каталог (id / название / описание / состояние по умолчанию) —
  `apps/desktop/src/shared/bundled-skills.ts`.

Добавить новый встроенный скилл: положить папку в `skills/<name>/` и дописать
запись в каталог. Проприетарный контент (несовместимые лицензии) сюда не класть —
см. `NOTICE`.
