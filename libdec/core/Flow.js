/* 
 * Copyright (C) 2017-2018 deroad
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */


module.exports = (function() {
    var Branch = require('libdec/core/Branch');
    var Scope = require('libdec/core/Scope');
    var Base = require('libdec/arch/base');
    var cfg = require('libdec/config');
    var Printable = require('libdec/printable');
    var Utils = require('libdec/core/Utils');

    var _label_counter = 0;

    var _colorize = function(input, color) {
        if (!color || input == '') return input;
        return color.colorize(input);
    }

    var ControlFlow = function(name, is_head, condition) {
        this.name = name || '';
        this.is_head = is_head;
        this.condition = condition;
        this.isElse = function() {
            return this.name.indexOf('else') >= 0;
        };
        this.printable = function(spacesize) {
            var p = new Printable();
            if (this.is_head) {
                p.appendFlow(this.name);
                if (this.condition) {
                    p.append(' ');
                    this.condition.printable(p);
                }
                p.append(' {');
            } else {
                if (this.name) {
                    p.append('} ');
                    p.appendFlow(this.name);
                } else {
                    p.append('}');
                }
                if (this.condition) {
                    p.append(' ');
                    this.condition.printable(p);
                    p.append(';');
                }
            }
            return p;
        };
        this.toString = function(options) {
            return (this.is_head ? '' : '} ') + _colorize(this.name, options.color) + (this.condition ? (' ' + this.condition.toString(options)) : '') + (this.is_head ? ' {' : (this.condition ? ';' : ''));
        }
    };

    ControlFlow.endBrace = function() {
        return new ControlFlow(null, false, null);
    };

    var ControlFlowPanic = function(name, is_head, condition) {
        this.name = name || '';
        this.condition = condition;
        this.printable = function(spacesize) {
            var p = new Printable();
            p.appendFlow(this.name);
            p.append(' ');
            p.appendObject(this.condition);
            p.append(';');
            return p;
        };
        this.toString = function(options) {
            return _colorize(this.name, options.color) + ' ' + this.condition.toString(options) + ';';
        }
    };

    var AddressBounds = function(low, hi) {
        this.low = low;
        this.hi = hi;
        this.isInside = function(addr) {
            return addr ? (addr.gte(this.low) && addr.lte(this.hi)) : false;
        }
    };

    var _compare_loc = function(a, b) {
        if (a.eq(b.loc)) {
            return 0;
        }
        return a.lt(b.loc) ? 1 : -1;
    };

    /* [long] jumps */
    var _detect_jumps = function(instructions, index, context) {
        var instr = instructions[index];
        if (context.limits.isInside(instr.jump)) {
            return false;
        }
        if (!instr.pseudo) {
            if (instr.cond) {
                _set_inline_if(instr, instr.scope.level + 1);
            }
            instr.pseudo = Base.instructions.goto(instr.jump);
        }
        return true;
    };

    var _set_inline_if = function(instr, level) {
        var scope = new Scope(level);
        var cond = Branch.generate(instr.cond.a, instr.cond.b, instr.cond.type, Branch.FLOW_INVERTED, Base);
        scope.header = new ControlFlow('if', true, cond);
        scope.trailer = ControlFlow.endBrace();
        instr.scope = scope
    };

    var _set_label = function(instructions, index, is_external) {
        var instr = instructions[index];
        if (is_external) {
            if (instr.cond) {
                _set_inline_if(instr, instr.scope.level + 1);
            }
            instr.pseudo = Base.instructions.goto(instr.jump);
            return false;
        }
        var found = Utils.search(instr.jump, instructions, _compare_loc);
        var pos = instructions.indexOf(found);
        if (found && pos != (index + 1)) {
            var label = (found.label < 0) ? _label_counter++ : found.label;
            found.label_xref++;
            found.label = label;
            instr.pseudo = Base.instructions.goto('label_' + label);
            /*
            if (instr.cond) {
                _set_inline_if(instr, instr.scope.level + 1);
            }
            */
            return true;
        }
        return false;
    };

    var _remove_label = function(instructions, index) {
        var instr = instructions[index];
        var found = Utils.search(instr.jump, instructions, _compare_loc);
        var pos = instructions.indexOf(found);
        if (found && pos != (index + 1)) {
            found.label_xref--;
            if (found.label_xref < 1) {
                found.label_xref = 0;
                found.label = -1;
            }
            instr.pseudo = Base.instructions.nop();
            return true;
        }
        return false;
    };

    var _shift_any_instruction_after_goto = function(instructions, index, level) {
        // reshift any instruction after the goto label_xxxxx.
        var instr = instructions[index];
        var scope = new Scope(level);
        for (var j = index + 1; j < instructions.length; j++) {
            var shift = instructions[j];
            if (instr.scope.uid != shift.scope.uid) {
                for (; j < instructions.length; j++) {
                    shift = instructions[j];
                    if (instr.scope.uid == shift.scope.uid) {
                        shift.scope = new Scope(level);
                    }
                }
                break;
            }
            shift.scope = scope;
        }
    };

    var _detect_if = function(instructions, index, context) {
        var instr = instructions[index];
        if (instr.jump.lte(instr.loc)) {
            return false;
        }
        if (!instr.cond) {
            // this is tricky.. to fix this on if { block } else { block }
            // it requires to rewrite the analysis loops..
            instr = instructions[index + 1];
            if (instr && !instr.scope.header || !instr.scope.header.isElse()) {
                _set_label(instructions, index, false);
            }
            return false;
        }

        var orig_scope = instr.scope;
        var scope = new Scope();
        var old_level = instr.scope.level;
        scope.level = old_level + 1;
        var end = instr.jump;
        var bounds = new AddressBounds(instr.loc, instr.jump);
        /* if(cond) { block } */
        var cond = Branch.generate(instr.cond.a, instr.cond.b, instr.cond.type, Branch.FLOW_DEFAULT, Base);
        var fail = instr.fail;
        var elseinst = null;
        scope.header = new ControlFlow('if', true, cond);
        scope.trailer = ControlFlow.endBrace();
        for (var i = index; i < instructions.length; i++) {
            instr = instructions[i];
            if (end.lte(instr.loc)) {
                break;
            }
            if (instr.scope.level == scope.level) {
                instr.scope.level++;
            } else if (instr.scope.level >= old_level && instr.scope.level < scope.level) {
                instr.scope = scope;
                elseinst = null;
            }
            if (instr.jump && instr.jump.gt(instr.loc) && context.limits.isInside(instr.jump) && !bounds.isInside(instr.jump)) {
                elseinst = instr;
                end = instr.jump;
                bounds = new AddressBounds(instr.loc, instr.jump)
                scope.trailer = ControlFlow.endBrace();
                scope = new Scope();
                scope.level = old_level + 1;
                scope.header = new ControlFlow(instr.cond ? 'else if' : 'else', true, instr.cond ? cond : null);
                scope.trailer = ControlFlow.endBrace();
                _remove_label(instructions, i);
            }
        }
        if (elseinst && elseinst.jump && elseinst.jump.gt(elseinst.loc)) {
            _set_label(instructions, instructions.indexOf(elseinst));
            elseinst = null;
        }
        return true;
    };

    var _detect_while = function(instructions, index, context) {
        var first = instructions[index];
        /* while(cond) { block } */
        if (!first.jump.lte(first.loc)) {
            return false;
        }
        /* infinite loop */
        var scope = new Scope();
        var bounds = new AddressBounds(first.jump, first.loc);
        var instr = Utils.search(first.jump, instructions, _compare_loc);
        if (!instr) {
            return false;
        }
        var cond = null;
        var start = instructions.indexOf(instr);
        var jmp_while = instructions[start - 1];
        var is_while = (jmp_while && !jmp_while.cond && bounds.isInside(jmp_while.jump));
        if (is_while) {
            cond = first.cond ? Branch.generate(first.cond.a, first.cond.b, first.cond.type, Branch.FLOW_INVERTED, Base) : Branch.false(Base);
            _remove_label(instructions, start - 1);
        } else {
            cond = first.cond ? Branch.generate(first.cond.a, first.cond.b, first.cond.type, Branch.FLOW_DEFAULT, Base) : Branch.true(Base);
        }
        if (instructions[start].scope.level > first.scope.level) {
            _set_label(instructions, index, !context.limits.isInside(first.jump));
            return true;
        }
        scope.level = instructions[start].scope.level + 1;
        scope.header = is_while ? (new ControlFlow('while', true, cond)) : new ControlFlow('do', true);
        if (first.jump.eq(first.loc)) {
            scope.header = new ControlFlowPanic('while', true, cond);
            scope.trailer = null;
            instr.scope = scope;
            return true;
        }
        var scopes = [];
        for (var i = start; i < index; i++) {
            instr = instructions[i];
            if (instr.scope.level == scope.level) {
                instr.scope.level++;
                scopes.push(instr.scope);
            } else if (instr.scope.level < scope.level) {
                instr.scope = scope;
            } else if (instr.scope.level > scope.level && scopes.indexOf(instr.scope) < 0) {
                scopes.push(instr.scope);
                instr.scope.level++;
            }
            if (instr.jump && instr.jump.gt(instr.loc) && !bounds.isInside(instr.jump)) {
                var label = _set_label(instructions, i, !context.limits.isInside(instr.jump));
                if (label) {
                    if (instr.cond && instr.scope.header && instr.scope.header.name == 'if') {
                        instr.scope.header.condition = Branch.generate(instr.cond.a, instr.cond.b, instr.cond.type, Branch.FLOW_INVERTED, Base);
                    }
                    _shift_any_instruction_after_goto(instructions, i, scope.level - 1);
                }
                if ((index + 1) == instructions.indexOf(Utils.search(instr.jump, instructions, _compare_loc))) {
                    if (label) {
                        _remove_label(instructions, i);
                    }
                    instr.pseudo = Base.instructions.break();
                }
            } else if (instr.jump && instr.jump.lt(instr.loc) && !bounds.isInside(instr.jump)) {
                if (instr.cond) {
                    _set_inline_if(instr, scope.level + 1)
                }
                _set_label(instructions, i, !context.limits.isInside(instr.jump));
            }
            /*
            else if(instr.jump && instr.jump.gt(instr.loc) && bounds.isInside(instr.jump) && instr.scope.header) {
                var jmppos = instructions.indexOf(Utils.search(instr.jump, instructions, _compare_loc));
                if (jmppos != (i + 1) && (index == jmppos || (index - 1) == jmppos)) {
                    // might be a cmp at index-1
                    instr.pseudo = Base.instructions.continue();
                }
            }
            */
        }
        scope.trailer = is_while ? ControlFlow.endBrace() : new ControlFlow('while', false, cond);
        return true;
    };

    return function(instructions) {
        var context = {
            limits: new AddressBounds(instructions[0].loc, instructions[instructions.length - 1].loc)
        };
        for (var i = 0; i < instructions.length; i++) {
            if (!instructions[i].jump) {
                continue;
            }
            if (!_detect_jumps(instructions, i, context)) {
                _detect_if(instructions, i, context);
            }
        }
        for (var i = 0; i < instructions.length; i++) {
            if (!instructions[i].jump) {
                continue;
            }
            if (!_detect_jumps(instructions, i, context)) {
                _detect_while(instructions, i, context)
            }
        }
    };
})();