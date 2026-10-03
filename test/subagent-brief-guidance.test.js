describe('sub-agent brief Markdown guidance', function() {
    test('spawn instructions require real headings and bullets, not fenced prose', async function() {
        var source = await loadFile('src/js/core/080-tools.js');
        var start = source.indexOf("name: 'spawn_sub_agent'");
        assert.ok(start >= 0);
        var field = source.slice(start).match(/instructions: (\{ type: 'string', description: '(?:\\.|[^'])*' \})/);
        assert.ok(field);
        var schema = new Function('return (' + field[1] + ');')();
        ['## Objective', '## Context', '## Boundaries', '## Deliverable', 'bullet lists', 'Do not wrap the brief in a code fence'].forEach(function(text) {
            assert.ok(schema.description.includes(text), text);
        });
    });
});
