// =============================================
// Emoji shortcodes — shared :name: → emoji map + inline converter.
// =============================================
// Moved here from ui/175-sub-agent-ui.js (PR #715 follow-up) so the map and
// replaceEmojiShortcodes() live in the CORE tier: defined before every
// renderer in the page bundle (chat streaming + final messages, collapsed
// tool-group text, sub-agent report cards/notices, agent_message callouts,
// progress-card / action-button outputs, smart documents, TLDR/caveat cards,
// skill asset views, dashboard preview — all of which funnel through
// formatContent in ui/250-message-render.js), and listed in
// WORKER_SHARED_FILES (build/build.js + skills/extension-dev/build.js) so
// the SW bundle can reach it too. DOM-free by construction.

// ── Shortcode → emoji map ──
// Curated GitHub-style shortcode → emoji map. Used BOTH for inline
// conversion (replaceEmojiShortcodes below, called unconditionally from
// formatContent in ui/250-message-render.js) and for the section-icon lift
// on sub-agent surfaces (_liftSectionIcon / _applySectionIcons in
// ui/175-sub-agent-ui.js). Unknown shortcodes are left untouched
// (graceful degradation).
var SECTION_ICON_SHORTCODES = {
    mag: '\uD83D\uDD0D', mag_right: '\uD83D\uDD0E', wrench: '\uD83D\uDD27',
    hammer: '\uD83D\uDD28', hammer_and_wrench: '\uD83D\uDEE0\uFE0F',
    gear: '\u2699\uFE0F', bug: '\uD83D\uDC1B', warning: '\u26A0\uFE0F',
    white_check_mark: '\u2705', heavy_check_mark: '\u2714\uFE0F',
    x: '\u274C', no_entry: '\u26D4', rocket: '\uD83D\uDE80',
    memo: '\uD83D\uDCDD', clipboard: '\uD83D\uDCCB', bulb: '\uD83D\uDCA1',
    fire: '\uD83D\uDD25', lock: '\uD83D\uDD12', unlock: '\uD83D\uDD13',
    key: '\uD83D\uDD11', package: '\uD83D\uDCE6',
    bar_chart: '\uD83D\uDCCA', chart_with_upwards_trend: '\uD83D\uDCC8',
    chart_with_downwards_trend: '\uD83D\uDCC9',
    stopwatch: '\u23F1\uFE0F', hourglass: '\u231B',
    hourglass_flowing_sand: '\u23F3', alarm_clock: '\u23F0',
    question: '\u2753', exclamation: '\u2757', pushpin: '\uD83D\uDCCC',
    link: '\uD83D\uDD17', file_folder: '\uD83D\uDCC1',
    open_file_folder: '\uD83D\uDCC2', card_file_box: '\uD83D\uDDC3\uFE0F',
    file_cabinet: '\uD83D\uDDC4\uFE0F', floppy_disk: '\uD83D\uDCBE',
    mailbox: '\uD83D\uDCEB', inbox_tray: '\uD83D\uDCE5',
    outbox_tray: '\uD83D\uDCE4', bell: '\uD83D\uDD14', zap: '\u26A1',
    sparkles: '\u2728', tada: '\uD83C\uDF89', construction: '\uD83D\uDEA7',
    shield: '\uD83D\uDEE1\uFE0F', telescope: '\uD83D\uDD2D',
    microscope: '\uD83D\uDD2C', test_tube: '\uD83E\uDDEA',
    dart: '\uD83C\uDFAF', checkered_flag: '\uD83C\uDFC1',
    triangular_flag_on_post: '\uD83D\uDEA9',
    arrows_counterclockwise: '\uD83D\uDD04', recycle: '\u267B\uFE0F',
    broom: '\uD83E\uDDF9', label: '\uD83C\uDFF7\uFE0F',
    bookmark: '\uD83D\uDD16', book: '\uD83D\uDCD6', books: '\uD83D\uDCDA',
    pencil: '\u270F\uFE0F', pencil2: '\u270F\uFE0F',
    speech_balloon: '\uD83D\uDCAC', thought_balloon: '\uD83D\uDCAD',
    eyes: '\uD83D\uDC40', brain: '\uD83E\uDDE0', robot: '\uD83E\uDD16',
    art: '\uD83C\uDFA8', wastebasket: '\uD83D\uDDD1\uFE0F',
    information_source: '\u2139\uFE0F',
    page_facing_up: '\uD83D\uDCC4', page_with_curl: '\uD83D\uDCC3',
    scroll: '\uD83D\uDCDC', newspaper: '\uD83D\uDCF0',
    bookmark_tabs: '\uD83D\uDCD1', mailbox_with_mail: '\uD83D\uDCEC',
    envelope: '\u2709\uFE0F', email: '\u2709\uFE0F', 'e-mail': '\uD83D\uDCE7',
    incoming_envelope: '\uD83D\uDCE8', calendar: '\uD83D\uDCC6',
    date: '\uD83D\uDCC5', stethoscope: '\uD83E\uDE7A',
    receipt: '\uD83E\uDDFE', notebook: '\uD83D\uDCD3',
    ballot_box_with_check: '\u2611\uFE0F',
    // ── Expanded gemoji coverage (fix: :abacus: was not detected; audit of
    // commonly-used GitHub shortcodes missing from the original curated set).
    // Names follow the canonical gemoji shortcode list; values are UTF-16
    // escapes like the entries above. Aliases (+1/thumbsup, phone/telephone,
    // boom/collision) map to the same emoji, matching gemoji.
    abacus: '\uD83E\uDDEE', '100': '\uD83D\uDCAF', '1234': '\uD83D\uDD22',
    heavy_plus_sign: '\u2795', heavy_minus_sign: '\u2796', heavy_multiplication_x: '\u2716\uFE0F',
    heavy_division_sign: '\u2797', infinity: '\u267E\uFE0F', '+1': '\uD83D\uDC4D',
    thumbsup: '\uD83D\uDC4D', '-1': '\uD83D\uDC4E', thumbsdown: '\uD83D\uDC4E',
    ok_hand: '\uD83D\uDC4C', wave: '\uD83D\uDC4B', clap: '\uD83D\uDC4F',
    muscle: '\uD83D\uDCAA', pray: '\uD83D\uDE4F', raised_hands: '\uD83D\uDE4C',
    handshake: '\uD83E\uDD1D', crossed_fingers: '\uD83E\uDD1E', v: '\u270C\uFE0F',
    writing_hand: '\u270D\uFE0F', point_right: '\uD83D\uDC49', point_left: '\uD83D\uDC48',
    point_up_2: '\uD83D\uDC46', point_down: '\uD83D\uDC47', eye: '\uD83D\uDC41\uFE0F',
    speaking_head: '\uD83D\uDDE3\uFE0F', bust_in_silhouette: '\uD83D\uDC64', busts_in_silhouette: '\uD83D\uDC65',
    detective: '\uD83D\uDD75\uFE0F', smile: '\uD83D\uDE04', smiley: '\uD83D\uDE03',
    grin: '\uD83D\uDE01', joy: '\uD83D\uDE02', wink: '\uD83D\uDE09',
    sweat_smile: '\uD83D\uDE05', thinking: '\uD83E\uDD14', sunglasses: '\uD83D\uDE0E',
    neutral_face: '\uD83D\uDE10', confused: '\uD83D\uDE15', grimacing: '\uD83D\uDE2C',
    roll_eyes: '\uD83D\uDE44', cry: '\uD83D\uDE22', sob: '\uD83D\uDE2D',
    scream: '\uD83D\uDE31', heart: '\u2764\uFE0F', broken_heart: '\uD83D\uDC94',
    heart_eyes: '\uD83D\uDE0D', star: '\u2B50', star2: '\uD83C\uDF1F',
    dizzy: '\uD83D\uDCAB', boom: '\uD83D\uDCA5', collision: '\uD83D\uDCA5',
    sweat_drops: '\uD83D\uDCA6', zzz: '\uD83D\uDCA4', bangbang: '\u203C\uFE0F',
    interrobang: '\u2049\uFE0F', grey_question: '\u2754', grey_exclamation: '\u2755',
    no_entry_sign: '\uD83D\uDEAB', stop_sign: '\uD83D\uDED1', vertical_traffic_light: '\uD83D\uDEA6',
    name_badge: '\uD83D\uDCDB', signal_strength: '\uD83D\uDCF6', sos: '\uD83C\uDD98',
    new: '\uD83C\uDD95', ok: '\uD83C\uDD97', up: '\uD83C\uDD99',
    cool: '\uD83C\uDD92', free: '\uD83C\uDD93', top: '\uD83D\uDD1D',
    arrow_right: '\u27A1\uFE0F', arrow_left: '\u2B05\uFE0F', arrow_up: '\u2B06\uFE0F',
    arrow_down: '\u2B07\uFE0F', arrows_clockwise: '\uD83D\uDD03', repeat: '\uD83D\uDD01',
    fast_forward: '\u23E9', rewind: '\u23EA', arrow_forward: '\u25B6\uFE0F',
    pause_button: '\u23F8\uFE0F', stop_button: '\u23F9\uFE0F', record_button: '\u23FA\uFE0F',
    trophy: '\uD83C\uDFC6', medal_sports: '\uD83C\uDFC5', '1st_place_medal': '\uD83E\uDD47',
    '2nd_place_medal': '\uD83E\uDD48', '3rd_place_medal': '\uD83E\uDD49', crown: '\uD83D\uDC51',
    gem: '\uD83D\uDC8E', moneybag: '\uD83D\uDCB0', money_with_wings: '\uD83D\uDCB8',
    credit_card: '\uD83D\uDCB3', dollar: '\uD83D\uDCB5', chart: '\uD83D\uDCB9',
    shopping_cart: '\uD83D\uDED2', computer: '\uD83D\uDCBB', desktop_computer: '\uD83D\uDDA5\uFE0F',
    keyboard: '\u2328\uFE0F', printer: '\uD83D\uDDA8\uFE0F', iphone: '\uD83D\uDCF1',
    telephone: '\u260E\uFE0F', phone: '\u260E\uFE0F', telephone_receiver: '\uD83D\uDCDE',
    satellite: '\uD83D\uDCE1', globe_with_meridians: '\uD83C\uDF10', earth_africa: '\uD83C\uDF0D',
    earth_americas: '\uD83C\uDF0E', earth_asia: '\uD83C\uDF0F', world_map: '\uD83D\uDDFA\uFE0F',
    compass: '\uD83E\uDDED', round_pushpin: '\uD83D\uDCCD', paperclip: '\uD83D\uDCCE',
    paperclips: '\uD83D\uDD87\uFE0F', scissors: '\u2702\uFE0F', straight_ruler: '\uD83D\uDCCF',
    triangular_ruler: '\uD83D\uDCD0', pen: '\uD83D\uDD8A\uFE0F', fountain_pen: '\uD83D\uDD8B\uFE0F',
    black_nib: '\u2712\uFE0F', paintbrush: '\uD83D\uDD8C\uFE0F', crayon: '\uD83D\uDD8D\uFE0F',
    spiral_calendar: '\uD83D\uDDD3\uFE0F', spiral_notepad: '\uD83D\uDDD2\uFE0F', ledger: '\uD83D\uDCD2',
    card_index: '\uD83D\uDCC7', card_index_dividers: '\uD83D\uDDC2\uFE0F', mega: '\uD83D\uDCE3',
    loudspeaker: '\uD83D\uDCE2', mute: '\uD83D\uDD07', sound: '\uD83D\uDD09',
    loud_sound: '\uD83D\uDD0A', battery: '\uD83D\uDD0B', electric_plug: '\uD83D\uDD0C',
    flashlight: '\uD83D\uDD26', candle: '\uD83D\uDD6F\uFE0F', camera: '\uD83D\uDCF7',
    video_camera: '\uD83D\uDCF9', movie_camera: '\uD83C\uDFA5', clapper: '\uD83C\uDFAC',
    film_strip: '\uD83C\uDF9E\uFE0F', tv: '\uD83D\uDCFA', radio: '\uD83D\uDCFB',
    headphones: '\uD83C\uDFA7', microphone: '\uD83C\uDFA4', musical_note: '\uD83C\uDFB5',
    notes: '\uD83C\uDFB6', lock_with_ink_pen: '\uD83D\uDD0F', closed_lock_with_key: '\uD83D\uDD10',
    old_key: '\uD83D\uDDDD\uFE0F', bomb: '\uD83D\uDCA3', skull: '\uD83D\uDC80',
    skull_and_crossbones: '\u2620\uFE0F', radioactive: '\u2622\uFE0F', biohazard: '\u2623\uFE0F',
    crossed_swords: '\u2694\uFE0F', bow_and_arrow: '\uD83C\uDFF9', pill: '\uD83D\uDC8A',
    syringe: '\uD83D\uDC89', dna: '\uD83E\uDDEC', petri_dish: '\uD83E\uDDEB',
    thermometer: '\uD83C\uDF21\uFE0F', magnet: '\uD83E\uDDF2', alembic: '\u2697\uFE0F',
    crystal_ball: '\uD83D\uDD2E', balance_scale: '\u2696\uFE0F', toolbox: '\uD83E\uDDF0',
    screwdriver: '\uD83E\uDE9B', nut_and_bolt: '\uD83D\uDD29', chains: '\u26D3\uFE0F',
    hammer_and_pick: '\u2692\uFE0F', pick: '\u26CF\uFE0F', axe: '\uD83E\uDE93',
    carpentry_saw: '\uD83E\uDE9A', ladder: '\uD83E\uDE9C', hook: '\uD83E\uDE9D',
    bricks: '\uD83E\uDDF1', door: '\uD83D\uDEAA', house: '\uD83C\uDFE0',
    office: '\uD83C\uDFE2', bank: '\uD83C\uDFE6', hospital: '\uD83C\uDFE5',
    factory: '\uD83C\uDFED', classical_building: '\uD83C\uDFDB\uFE0F', car: '\uD83D\uDE97',
    truck: '\uD83D\uDE9A', airplane: '\u2708\uFE0F', ship: '\uD83D\uDEA2',
    anchor: '\u2693', fuelpump: '\u26FD', game_die: '\uD83C\uDFB2',
    jigsaw: '\uD83E\uDDE9', joystick: '\uD83D\uDD79\uFE0F', video_game: '\uD83C\uDFAE',
    '8ball': '\uD83C\uDFB1', performing_arts: '\uD83C\uDFAD', ticket: '\uD83C\uDFAB',
    gift: '\uD83C\uDF81', balloon: '\uD83C\uDF88', confetti_ball: '\uD83C\uDF8A',
    popcorn: '\uD83C\uDF7F', ghost: '\uD83D\uDC7B', alien: '\uD83D\uDC7D',
    space_invader: '\uD83D\uDC7E', seedling: '\uD83C\uDF31', herb: '\uD83C\uDF3F',
    evergreen_tree: '\uD83C\uDF32', deciduous_tree: '\uD83C\uDF33', sunny: '\u2600\uFE0F',
    cloud: '\u2601\uFE0F', cyclone: '\uD83C\uDF00', rainbow: '\uD83C\uDF08',
    snowflake: '\u2744\uFE0F', droplet: '\uD83D\uDCA7', ocean: '\uD83C\uDF0A',
    comet: '\u2604\uFE0F', crescent_moon: '\uD83C\uDF19', snail: '\uD83D\uDC0C',
    turtle: '\uD83D\uDC22', snake: '\uD83D\uDC0D', penguin: '\uD83D\uDC27',
    whale: '\uD83D\uDC33', octopus: '\uD83D\uDC19', unicorn: '\uD83E\uDD84',
    owl: '\uD83E\uDD89', fox_face: '\uD83E\uDD8A', spider: '\uD83D\uDD77\uFE0F',
    spider_web: '\uD83D\uDD78\uFE0F', watch: '\u231A', timer_clock: '\u23F2\uFE0F',
    coffee: '\u2615',
    rotating_light: '\uD83D\uDEA8', gears: '\u2699\uFE0F',
    // Convenience alias — NOT canonical gemoji (GitHub has no :check:), but
    // commonly typed; maps to the same emoji as :white_check_mark:.
    check: '\u2705'
};

// General inline emoji-shortcode -> Unicode conversion for the shared
// markdown pipeline. Called from formatContent (250-message-render.js)
// AFTER inline <code>, markdown links and bare-URL autolinking have run and
// WHILE fenced code is still a %%CODEBLOCK%% placeholder, so every ':' that
// belongs to a code span or a URL sits inside <code>..</code> / <a ..>..</a>
// (or a placeholder) and is left untouched. Reuses the curated
// SECTION_ICON_SHORTCODES map above via an OWN-property lookup (unknown
// names, and prototype keys like :constructor:, stay literal). Unlike
// _liftSectionIcon this converts shortcodes ANYWHERE in the text, not only
// a leading heading token.
function replaceEmojiShortcodes(html) {
    if (!html || html.indexOf(':') === -1) return html;
    // Stash links + inline code so a ':' inside them is never rewritten
    // (same technique as the autolinker in formatContent). NUL-delimited
    // markers cannot collide with escaped markdown output.
    var spans = [];
    var s = html.replace(/<a\b[^>]*>[\s\S]*?<\/a>|<code\b[^>]*>[\s\S]*?<\/code>/g, function(m) {
        spans.push(m);
        return '\u0000E' + (spans.length - 1) + '\u0000';
    });
    s = s.replace(/:([a-z0-9_+-]+):/g, function(whole, name) {
        var emoji = Object.prototype.hasOwnProperty.call(SECTION_ICON_SHORTCODES, name)
            ? SECTION_ICON_SHORTCODES[name] : null;
        return (typeof emoji === 'string' && emoji) ? emoji : whole;
    });
    // Function replacement so $-sequences in a restored href/text stay literal.
    for (var i = 0; i < spans.length; i++) {
        (function(span, idx) {
            s = s.replace('\u0000E' + idx + '\u0000', function() { return span; });
        })(spans[i], i);
    }
    return s;
}
