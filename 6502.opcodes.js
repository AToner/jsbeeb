function replaceReg(lines, reg) {
    "use strict";
    return lines.map(function(line) { return line.replace(/REG/g, reg); });
}

function rotate(left, logical) {
    "use strict";
    var lines = [];
    if (!left) {
        if (!logical) lines.push("var newTopBit = cpu.p.c ? 0x80 : 0x00;");
        lines.push("cpu.p.c = !!(REG & 0x01);");
        if (logical) {
            lines.push("REG >>= 1;");
        } else {
            lines.push("REG = (REG >> 1) | newTopBit;");
        }
    } else {
        if (!logical) lines.push("var newTopBit = cpu.p.c ? 0x01 : 0x00;");
        lines.push("cpu.p.c = !!(REG & 0x80);");
        if (logical) {
            lines.push("REG = (REG << 1) & 0xff;");
        } else {
            lines.push("REG = ((REG << 1) & 0xff) | newTopBit;");
        }
    }
    lines.push("cpu.setzn(REG);");
    return lines;
}

function InstructionGen() {
    "use strict";
    var self = this;
    self.ops = {};
    self.cycle = 0;

    self.flush = function() {
        if (!self.ops[self.cycle]) throw "erk";
        self.ops[self.cycle].exact = true;
    };

    self.append = function(cycle, op, exact) {
        if (op === undefined) {
            op = cycle;
            cycle = self.cycle;
        }
        exact = exact || false;
        if (typeof(op) == "string") op = [op];
        if (self.ops[cycle])  {
            self.ops[cycle].op = self.ops[cycle].op.concat(op);
            self.ops[cycle].exact |= exact;
        } else
            self.ops[cycle] = {op: op, exact: exact };
    };

    self.tick = function(cycles) { self.cycle += (cycles || 1); }
    self.readOp = function(op) {
        self.cycle++;
        self.append(self.cycle, op, true);
    };
    self.writeOp = function(op) {
        self.cycle++;
        self.append(self.cycle, op, true);
    };
    self.zpReadOp = function(op) {
        self.cycle++;
        self.append(self.cycle, op, false);
    };
    self.zpWriteOp = function(op) {
        self.cycle++;
        self.append(self.cycle, op, false);
    };
    self.render = function(zpOnly) {
        zpOnly = zpOnly || false;
        if (zpOnly) {
            // Check interrupts at the end to hopefully coalesce time.
            self.append(self.cycle, "cpu.checkInt();", true);
        } else {
            // Check on penultimate cycle.
            self.append(self.cycle - 1, "cpu.checkInt();", true);
        }
        var i;
        var toSkip = 0;
        var out = [];
        for (i = 0; i < self.cycle; ++i) {
            if (!self.ops[i]) {
                toSkip++;
                continue;
            }
            if (toSkip && self.ops[i].exact) {
                out.push("cpu.polltime(" + toSkip + ");");
                toSkip = 0;
            }
            out = out.concat(self.ops[i].op);
            toSkip++;
        }
        if (toSkip) out.push("cpu.polltime(" + toSkip + ");");
        if (self.ops[self.cycle]) out = out.concat(self.ops[self.cycle].op);
        return out;
    };
}

function getOp(op) {
    "use strict";
    switch (op) {
    case "LDA": return { op: ["cpu.a = REG;", "cpu.setzn(cpu.a);"], read: true, write: false };
    case "STA": return { op: ["REG = cpu.a;"], read: false, write: true };
    case "INC": return { 
        op: ["REG = (REG + 1) & 0xff;", "cpu.setzn(REG);"], 
        read: true, write: true 
    };
    case "DEC": return { 
        op: ["REG = (REG - 1) & 0xff;", "cpu.setzn(REG);"], 
        read: true, write: true 
    };
    case "ROL": return { op: rotate(true, false), read: true, write: true };
    case "ROR": return { op: rotate(false, false), read: true, write: true };
    case "ASL": return { op: rotate(true, true), read: true, write: true };
    case "ASR": return { op: rotate(false, true), read: true, write: true };
    case "EOR": return { op: ["cpu.a ^= REG;", "cpu.setzn(cpu.a);"], read: true, write: false };
    case "CMP": return { op: ["cpu.setzn(cpu.a - REG);", "cpu.p.c = cpu.a >= REG;"], 
        read: true, write: false };
    }
    return null;
}

function getInstruction2(opcodeString) {
    "use strict";
    var split = opcodeString.split(' ');
    var opcode = split[0];
    var arg = split[1];
    var reg = opcode[2].toLowerCase();
    var op = getOp(opcode);
    var indexReg;
    if (!op) return null;

    var ig = new InstructionGen();
    ig.append("var REG = 0|0;");

    var opCount = 1;
    switch (arg) {
    case undefined:
        return null;

    case "zp":
        ig.tick(2);
        ig.append("var addr = cpu.getb();");
        if (op.read) {
            ig.zpReadOp("REG = cpu.readmem(addr);");
            if (op.write) ig.tick(1);  // Spurious write
        }
        ig.append(op.op);
        if (op.write) {
            ig.zpWriteOp("cpu.writemem(addr, REG);");
        }
        return ig.render(true);

    case "abs":
        ig.tick(3);
        ig.append("var addr = cpu.getw();");
        if (op.read) {
            ig.readOp("REG = cpu.readmem(addr);");
            if (op.write) 
                ig.writeOp("cpu.writemem(addr, REG);");
        }
        ig.append(op.op);
        if (op.write) {
            ig.writeOp("cpu.writemem(addr, REG);");
        }

        return ig.render(false);

    case "abs,x":
    case "abs,y":
        ig.tick(3);
        indexReg = arg[4];
        ig.append("var addr = cpu.getw();");
        ig.append("var addrWithCarry = (addr + cpu." + indexReg + ") & 0xffff;");
        ig.append("var addrNonCarry = (addr & 0xff00) | (addrWithCarry & 0xff);");
        if (op.read) {
            ig.readOp("REG = cpu.readmem(addrNonCarry);");
            if (!op.write) {
                // For non-RMW, we only pay the cost of the spurious read if the address carried
                ig.flush();
                ig.append("if (addrWithCarry !== addrNonCarry) {");
                ig.append("    cpu.polltime(1);");
                ig.append("    REG = cpu.readmem(addrWithCarry);");
                ig.append("}");
            } else {
                // For RMW we always have a spurious read and then a spurious write
                ig.readOp("REG = cpu.readmem(addrWithCarry);");
                ig.writeOp("cpu.writemem(addrWithCarry, REG); // Spurious write");
            }
        } else if (op.write) {
            // Pure stores still exhibit a read at the non-carried address.
            ig.readOp("cpu.readmem(addrNonCarry);");
        }
        ig.append(op.op);
        if (op.write) {
            ig.writeOp("cpu.writemem(addrWithCarry, REG);");
        }
        // TODO: LDA abs,x is broken as the interrupt check can occur one cycle too early if
        // there's a carry.
        return ig.render();

    case "zp,x":
    case "zp,y":
    case "A":
    case "imm":
    case "(),y":
    case "(,y)":
    case "(,x)":
    case "branch": case "()": case "zpx":
        return null;

    default:
        throw "Unknown arg type " + arg;
    }
    return null;
}

function compileInstruction2(ins) {
    "use strict";
    var lines = getInstruction2(ins);;
    if (!lines) return null;
    var text = "var f = function(cpu) {\n    \"use strict\";\n    " + lines.join("\n    ") + "\n}\n;f\n";
    try {
        return eval(text); // jshint ignore:line
    } catch (e) {
        throw "Unable to compile: " + e + "\nText:\n" + text;
    }
}

///////////////////////////////////////////////////////
//
function getGetPut(arg) {
    "use strict";
    switch (arg) {
    case "zp":
        return {
            reg: "temp",
            get: ["var addr = cpu.getb();", "var temp = cpu.readmem(addr);"],
            reget: [],
            put: ["cpu.writemem(addr, temp);"],
            opcodeCycles: 1,
            memoryCycles: 1,
        };
    case "zp,x":
        return {
            reg: "temp",
            get: ["var addr = (cpu.getb() + cpu.x) & 0xff;", "var temp = cpu.readmem(addr);"],
            reget: [],
            put: ["cpu.writemem(addr, temp);"],
            opcodeCycles: 1,
            memoryCycles: 1,
        };
    case "zp,y":
        return {
            reg: "temp",
            get: ["var addr = (cpu.getb() + cpu.y) & 0xff;", "var temp = cpu.readmem(addr);"],
            reget: [],
            put: ["cpu.writemem(addr, temp);"],
            opcodeCycles: 1,
            memoryCycles: 1,
        };
    case "A":
        return {
            reg: "cpu.a",
            get: [],
            reget: [],
            put: [],
            opcodeCycles: 0,
            memoryCycles: 0,
        };
    case "imm":
        return {
            reg: "temp",
            get: ["var temp = cpu.getb();"],
            reget: [],
            put: [],
            opcodeCycles: 1,
            memoryCycles: 0,
        };
    case "abs":
        return {
            reg: "temp",
            get: ["var addr = cpu.getw();", "var temp = cpu.readmem(addr);"],
            reget: ["cpu.readmem(addr);"],
            put: ["cpu.writemem(addr, temp);"],
            opcodeCycles: 2,
            memoryCycles: 1,
        };
    case "abs,x":
    case "abs,y":
        return {
            reg: "temp",
            get: [
                "var temp = cpu.getw();",
                "var addr = temp + cpu." + arg[4] +";",
                "if ((addr & 0xff00) != (temp & 0xff00)) cpu.polltime(1);",
                "temp = cpu.readmem(addr);",
                ],
            reget: ["cpu.readmem(addr);"],
            put: ["cpu.writemem(addr, temp);"],
            opcodeCycles: 2,
            memoryCycles: 1,
        };
    case "(),y":
        return {
            reg: "temp",
            get: [
                "var temp = cpu.getb();",
                "var baseAddr = cpu.readmem(temp) | (cpu.readmem(temp + 1) << 8);",
                "var addr = baseAddr + cpu.y",
                "if ((baseAddr & 0xff00) != (addr & 0xff00)) cpu.polltime(1);",
                "temp = cpu.readmem(addr);",
                ],
            reget: ["cpu.readmem(addr);"],
            put: ["throw \"bad fit\""],
            opcodeCycles: 1,
            memoryCycles: 3,
        };
    case "(,x)":
        return {
            reg: "temp",
            get: [
                "var temp = cpu.getb() + cpu.x;",
                "var addr = cpu.readmem(temp) | (cpu.readmem(temp + 1) << 8);",
                "temp = cpu.readmem(addr);",
                ],
            reget: [],
            put: ["throw \"bad fit\""],
            opcodeCycles: 1,
            memoryCycles: 4,  // Not sure this is correct
        };
    }
}

function compileLoad(reg, arg) {
    "use strict";
    if (arg == 'imm' && reg == 'a') {
        // Special cased as it is in b-em. TODO: make all instructions checkInt on penult cyc
        return replaceReg([
            "cpu.REG = cpu.getb();",
            "cpu.setzn(cpu.REG);",
            "cpu.polltime(1);",
            "cpu.checkInt();",
            "cpu.polltime(1);",
        ], reg);
    }
    var gp = getGetPut(arg);
    if (!gp) return null;
    var lines = ["cpu.polltime(" + (gp.opcodeCycles + gp.memoryCycles) + ");"].concat(gp.get)
    if (gp.reg != reg) lines.push("cpu." + reg + " = " + gp.reg + ";");
    return lines.concat([
            "cpu.setzn(cpu." + reg + ");",
            "cpu.polltime(1);",
            "cpu.checkInt();"]
            );
}

function compileStore(reg, arg) {
    "use strict";
    var off;
    if (arg == 'abs') {
        return replaceReg([
                "var addr = cpu.getw();",
                "cpu.polltime(4);",
                "cpu.checkInt();",
                "cpu.writemem(addr, cpu.REG);"
                ], reg);
    } else if (arg.match(/^abs,[xy]/)) {
        off = arg[4];
        return replaceReg([
                "var addr = cpu.getw();",
                "cpu.polltime(4);",
                "var offsetAddr = (addr + cpu." + off + ") & 0xffff;",
                "var weirdReadAddr = (addr & 0xff00) | (offsetAddr & 0xff);",
                "cpu.readmem(weirdReadAddr);",
                "cpu.polltime(1);",
                "cpu.checkInt();",
                "cpu.writemem(offsetAddr, cpu.REG);"
                ], reg);
    } else if (arg == 'zp') {
        return replaceReg([
                "var addr = cpu.getb();",
                "cpu.writemem(addr, cpu.REG);",
                "cpu.polltime(3);",
                "cpu.checkInt();",
                ], reg);
    } else if (arg.match(/^zp,[xy]/)) {
        off = arg[3];
        return replaceReg([
                "var addr = cpu.getb();",
                "cpu.writemem((addr + cpu." + off + ") & 0xff, cpu.REG);",
                "cpu.polltime(4);",
                "cpu.checkInt();",
                ], reg);
    } else if (arg.substr(0, 2) == "()") {
        off = arg[3];
        return replaceReg([
                "var zp = cpu.getb();",
                "var addr = cpu.readmem(zp) + (cpu.readmem((zp + 1) & 0xff) << 8) + cpu." + off + ";",
                "cpu.writemem(addr, cpu.REG);",
                "cpu.polltime(6);",
                "cpu.checkInt();"
                ], reg);
    } else if (arg == "(,x)") {
        off = arg[3];
        return replaceReg([
                "var zp = cpu.getb() + cpu.x;",
                "var addr = cpu.readmem(zp) + (cpu.readmem((zp + 1) & 0xff) << 8);",
                "cpu.writemem(addr, cpu.REG);",
                "cpu.polltime(6);",
                "cpu.checkInt();"
                ], reg);
    }
}

function compileCompare(arg, reg) {
    "use strict";
    var gp = getGetPut(arg);
    if (!gp) return null;
    return gp.get.concat(replaceReg([
            "cpu.setzn(cpu.REG - " + gp.reg + ");",
            "cpu.p.c = (cpu.REG >= " + gp.reg + ");",
            "cpu.polltime(" + (1 + gp.opcodeCycles + gp.memoryCycles) + ");",
            "cpu.checkInt()"],
            reg));
}

function compileTransfer(from, to) {
    "use strict";
    var lines = ["cpu." + to + " = cpu." + from + ";"];
    if (to != "s") lines.push("cpu.setzn(cpu." + to + ");");
    lines.push("cpu.polltime(2);");
    lines.push("cpu.checkInt();");
    return lines;
}

function compileAsl(arg) {
    "use strict";
    if (arg == 'A') {
        return [
            "cpu.p.c = !!(cpu.a & 0x80);",
            "cpu.a = (cpu.a << 1) & 0xff;",
            "cpu.setzn(cpu.a);",
            "cpu.polltime(2);",
            "cpu.checkInt();"
                ];
    }
    var gp = getGetPut(arg);
    if (!gp) return null;
    return gp.get.concat([
            "cpu.p.c = !!(" + gp.reg + " & 0x80);",
            gp.reg + " = (" + gp.reg + " << 1) & 0xff;",
            "cpu.setzn(" + gp.reg + ");"
            ])
        .concat(gp.put).concat([
            "cpu.polltime(" + (1 + gp.opcodeCycles + gp.memoryCycles) + ");",
            "cpu.checkInt();"]);
            
}

function compilePush(reg) {
    "use strict";
    var lines = [];
    if (reg == 'p') {
        lines = lines.concat([ "var temp = cpu.p.asByte();"]);
        reg = 'temp';
    } else {
        reg = 'cpu.' + reg;
    }
    return lines.concat(replaceReg([
        "cpu.push(REG);",
        "cpu.polltime(3);",
        "cpu.checkInt()",  // TODO - PHY PHX don't check ints in b-em. bug?
        ], reg));
}

function compilePull(reg) {
    "use strict";
    if (reg == 'p') {
        return [
                "var temp = cpu.pull();",
                "cpu.polltime(4);",
                "cpu.checkInt();",
                "cpu.p.c = !!(temp & 0x01);",
                "cpu.p.z = !!(temp & 0x02);",
                "cpu.p.i = !!(temp & 0x04);",
                "cpu.p.d = !!(temp & 0x08);",
                "cpu.p.v = !!(temp & 0x40);",
                "cpu.p.n = !!(temp & 0x80);"
                    ];
    }
    return replaceReg([
        "cpu.REG = cpu.pull();",
        "cpu.setzn(cpu.REG);",
        "cpu.polltime(4);",
        "cpu.checkInt()",  // TODO - PLY PLX don't check ints in b-em. bug?
        ], reg);
}

function compileBranch(condition) {
    "use strict";
    switch (condition) {
    case "eq":
        return ["cpu.branch(cpu.p.z);"];
    case "ne":
        return ["cpu.branch(!cpu.p.z);"];
    case "cs":
        return ["cpu.branch(cpu.p.c);"];
    case "cc":
        return ["cpu.branch(!cpu.p.c);"];
    case "mi":
        return ["cpu.branch(cpu.p.n);"];
    case "pl":
        return ["cpu.branch(!cpu.p.n);"];
    case "vs":
        return ["cpu.branch(cpu.p.v);"];
    case "vc":
        return ["cpu.branch(!cpu.p.v);"];
    }
}

function compileJsr() {
    "use strict";
    return [
        "var addr = cpu.getw();",
        "var pushAddr = cpu.pc - 1;",
        "cpu.push(pushAddr >> 8);",
        "cpu.push(pushAddr & 0xff);",
        "cpu.pc = addr;",
        "cpu.polltime(5);",
        "cpu.checkInt();",
        "cpu.polltime(1);",
        ];
}

function compileRts() {
    "use strict";
    return [
        "var temp = cpu.pull();",
        "temp |= cpu.pull() << 8;",
        "cpu.pc = temp + 1;",
        "cpu.polltime(5);",
        "cpu.checkInt();",
        "cpu.polltime(1);",
        ];
}

function compileRti() {
    "use strict";
    return [
        "var temp = cpu.pull();",
        "cpu.p.c = temp & 1;",
        "cpu.p.z = temp & 2;",
        "cpu.p.i = temp & 4;",
        "cpu.p.d = temp & 8;",
        "cpu.p.v = temp & 0x40;",
        "cpu.p.n = temp & 0x80;",
        "temp = cpu.pull();",
        "cpu.pc = temp | cpu.pull() << 8;",
        "cpu.polltime(6);",
        "cpu.checkInt();",
        ];
}


function compileAddDec(reg, arg, addOrDec) {
    "use strict";
    if (arg === undefined) {
        return replaceReg([
            "cpu.REG = (cpu.REG " + addOrDec + ") & 0xff;",
            "cpu.setzn(cpu.REG);",
            "cpu.polltime(2);",
            "cpu.checkInt();",
            ], reg);
    } else if (arg == "abs") {
        // Hugely hand-crafted looking RMW instruction:
        // TODO: 65c02 version
        return [
            "var addr = cpu.getw();",
            "cpu.polltime(4);",
            "var oldValue = cpu.readmem(addr);",
            "var newValue = (oldValue " + addOrDec + ") & 0xff;",
            "cpu.polltime(1);",
            "cpu.writemem(addr, oldValue);",
            "cpu.checkViaIntOnly();",
            "cpu.polltime(1);",
            "cpu.checkInt();",
            "cpu.writemem(addr, newValue);",
            "cpu.setzn(newValue);"
            ];
    } else if (arg == "abs,x") {
        return [
            "var addr = cpu.getw();",
            "cpu.readmem((addr & 0xff00) | ((addr + cpu.x) & 0xff));",
            "addr += cpu.x;",
            "var oldValue = cpu.readmem(addr);",
            "var newValue = (oldValue " + addOrDec + ") & 0xff;",
            "cpu.writemem(addr, oldValue);",
            "cpu.writemem(addr, newValue);",
            "cpu.setzn(newValue);",
            "cpu.polltime(7);",
            "cpu.checkInt();"
            ];
    } else {
        var getput = getGetPut(arg);
        if (!getput) return null;
        return getput.get.concat([
            getput.reg + " = (" + getput.reg + " " + addOrDec + ") & 0xff;",
            "cpu.setzn(" + getput.reg + ");",
            "cpu.polltime(" + (1 + getput.opcodeCycles + 2*getput.memoryCycles) + ");" // todo why is the cycle count wrong?
            ]).concat(getput.put);
    }
}


function compileRotate(left, logical, arg) {
    "use strict";
    var getput = getGetPut(arg);
    if (!getput) return null;
    var lines = ["cpu.polltime(" + (1 + getput.opcodeCycles + getput.memoryCycles) + ");"];
    lines = lines.concat(getput.get);
    lines.push("cpu.polltime(" + getput.memoryCycles + ")");
    lines = lines.concat(getput.put);
    if (!left) {
        if (!logical) lines.push("var newTopBit = cpu.p.c ? 0x80 : 0x00;");
        lines.push("cpu.p.c = !!(" + getput.reg + " & 0x01);");
        if (logical) {
            lines.push(getput.reg + " >>= 1;");
        } else {
            lines.push(getput.reg + " = (" + getput.reg + " >> 1) | newTopBit;");
        }
    } else {
        if (!logical) lines.push("var newTopBit = cpu.p.c ? 0x01 : 0x00;");
        lines.push("cpu.p.c = !!(" + getput.reg + " & 0x80);");
        if (logical) {
            lines.push(getput.reg + " = (" + getput.reg + " << 1) & 0xff;");
        } else {
            lines.push(getput.reg + " = ((" + getput.reg + " << 1) & 0xff) | newTopBit;");
        }
    }
    lines.push("cpu.setzn(" + getput.reg + ");");
    lines = lines.concat(getput.put);
    return lines.concat([ "cpu.checkInt();", "cpu.polltime(" + (getput.memoryCycles) + ");" ]);
}

function compileLogical(arg, op) {
    "use strict";
    var getput = getGetPut(arg);
    if (!getput) return null;
    // Is this right? needed?
    var lines = ["cpu.polltime(" + (getput.opcodeCycles + getput.memoryCycles) + ");"].concat(getput.get);
    lines.push("cpu.a " + op + "= " + getput.reg + ";");
    lines.push("cpu.setzn(cpu.a);");
    lines.push("cpu.polltime(1);");
    lines.push("cpu.checkInt();");
    return lines;
}

function compileJump(arg) {
    "use strict";
    if (arg == "abs") {
        return [
            "cpu.pc = cpu.getw();",
            "cpu.polltime(3);",
            "cpu.checkInt();"
                ];
    } else if (arg == "()") {
        return [
            "var addr = cpu.getw();",
            "var nextAddr = ((addr + 1) & 0xff) | (addr & 0xff00);",
            "cpu.pc = cpu.readmem(addr) | (cpu.readmem(nextAddr) << 8);",
            "cpu.polltime(5);",
            "cpu.checkInt();"
                ];
    }
}

function compileBit(arg) {
    "use strict";
    if (arg == "imm") {
        // 65c02 instr.
        return [
            "cpu.p.z = !(cpu.a & cpu.getb());",
            "cpu.polltime(2);"
                ];  // TODO: No checkint?
    } else if (arg == "abs") {
        // TODO: b-em special cases the timing here.
    }
    
    var getput = getGetPut(arg);
    if (!getput) return null;
    return getput.get.concat([
            "cpu.p.z = !(cpu.a & " + getput.reg + ");",
            "cpu.p.v = !!(" + getput.reg + " & 0x40);",
            "cpu.p.n = !!(" + getput.reg + " & 0x80);",
            "cpu.polltime(" + (1 + getput.opcodeCycles + getput.memoryCycles) + ");",
            "cpu.checkInt();"
                ]);
}

function compileAdcSbc(inst, arg) {
    "use strict";
    var getput = getGetPut(arg);
    if (!getput) return null;
    return getput.get.concat([
            "cpu." + inst + "(" + getput.reg + ");",
            "cpu.polltime(" + (1 + getput.opcodeCycles + getput.memoryCycles) + ");",
            "cpu.checkInt();"]);
}

function compileNop(arg) {
    "use strict";
    if (arg) return null;
    return ["cpu.polltime(2);", "cpu.checkInt();"];
}

function compileInstruction(opcodeString) {
    var split = opcodeString.split(' ');
    var opcode = split[0];
    var arg = split[1];
    var lines = null;
    var reg = opcode[2].toLowerCase();
    if (opcode.match(/^LD/)) {
        lines = compileLoad(reg, arg);
    } else if (opcode.match(/^ST/)) {
        lines = compileStore(reg, arg);
    } else if (opcode == "SEI") {
        lines = ["cpu.polltime(2);", "cpu.checkInt();", "cpu.p.i = true;"];
    } else if (opcode == "CLI") {
        lines = ["cpu.polltime(2);", "cpu.checkInt();", "cpu.p.i = false;"];
    } else if (opcode == "SEC") {
        lines = ["cpu.polltime(2);", "cpu.checkInt();", "cpu.p.c = true;"];
    } else if (opcode == "CLC") {
        lines = ["cpu.polltime(2);", "cpu.checkInt();", "cpu.p.c = false;"];
    } else if (opcode == "SED") {
        lines = ["cpu.p.d = true;", "cpu.polltime(2);", "cpu.checkInt();"];
    } else if (opcode == "CLD") {
        lines = ["cpu.p.d = false;", "cpu.polltime(2);", "cpu.checkInt();"];
    } else if (opcode == "CLV") {
        lines = ["cpu.p.v = false;", "cpu.polltime(2);", "cpu.checkInt();"];
    } else if (opcode[0] == 'T') {
        lines = compileTransfer(opcode[1].toLowerCase(), opcode[2].toLowerCase());
    } else if (opcode == 'ASL') {
        lines = compileAsl(arg);
    } else if (opcode.match(/^PH/)) {
        lines = compilePush(reg);
    } else if (opcode.match(/^PL/)) {
        lines = compilePull(reg);
    } if (opcode == "BIT") {
        lines = compileBit(arg);
    } else if (opcode == "BRK") {
        lines = ["cpu.brk();"];
    } else if (opcode[0] == 'B') {
        lines = compileBranch(opcode.substr(1,2).toLowerCase());
    } else if (opcode == "CMP") {
        lines = compileCompare(arg, "a");
    } else if (opcode.match(/^CP/)) {
        lines = compileCompare(arg, opcode[2].toLowerCase());
    } else if (opcode.match(/^DE/)) {
        lines = compileAddDec(opcode[2].toLowerCase(), arg, "- 1");
    } else if (opcode.match(/^IN/)) {
        lines = compileAddDec(opcode[2].toLowerCase(), arg, "+ 1");
    } else if (opcode == "JSR") {
        lines = compileJsr();
    } else if (opcode == "RTS") {
        lines = compileRts();
    } else if (opcode == "RTI") {
        lines = compileRti();
    } else if (opcode == "ROR") {
        lines = compileRotate(false, false, arg);
    } else if (opcode == "ROL") {
        lines = compileRotate(true, false, arg);
    } else if (opcode == "LSR") {
        lines = compileRotate(false, true, arg);
    } else if (opcode == "LSL") {
        lines = compileRotate(true, true, arg);
    } else if (opcode == "AND") {
        lines = compileLogical(arg, "&");
    } else if (opcode == "ORA") {
        lines = compileLogical(arg, "|");
    } else if (opcode == "EOR") {
        lines = compileLogical(arg, "^");
    } else if (opcode == "JMP") {
        lines = compileJump(arg);
    } else if (opcode == "ADC" || opcode == "SBC") {
        lines = compileAdcSbc(opcode.toLowerCase(), arg);
    } else if (opcode == "NOP") {
        lines = compileNop(arg);
    }
    if (!lines) return null;
    var fnName = "compiled_" + opcodeString.replace(/[^a-zA-Z0-9]+/g, '_');
    var text = fnName + " = function(cpu) {\n    \"use strict\";\n    " + lines.join("\n    ") + "\n}\n";
    try {
        eval(text); // jshint ignore:line
    } catch (e) {
        throw "Unable to compile: " + e + "\nText:\n" + text;
    }
    return this[fnName];
}

var opcodes6502 = {
    0x00: "BRK",
    0x01: "ORA (,x)",
    0x03: "SLO (,x)",
    0x04: "NOP zp",
    0x05: "ORA zp",
    0x06: "ASL zp",
    0x07: "SLO zp",
    0x08: "PHP",
    0x09: "ORA imm",
    0x0A: "ASL A",
    0x0B: "ANC imm",
    0x0C: "NOP abs",
    0x0D: "ORA abs",
    0x0E: "ASL abs",
    0x0F: "SLO abs",
    0x10: "BPL branch",
    0x11: "ORA (),y",
    0x13: "SLO (),y",
    0x14: "NOP zp,x",
    0x15: "ORA zp,x",
    0x16: "ASL zp,x",
    0x17: "SLO zp,x",
    0x18: "CLC",
    0x19: "ORA abs,y",
    0x1A: "NOP",
    0x1B: "SLO abs,y",
    0x1C: "NOP abs,x",
    0x1D: "ORA abs,x",
    0x1E: "ASL abs,x",
    0x1F: "SLO abs,x",
    0x20: "JSR abs",
    0x21: "AND (,x)",
    0x23: "RLA (,x)",
    0x24: "BIT zp",
    0x25: "AND zp",
    0x26: "ROL zp",
    0x27: "RLA zp",
    0x28: "PLP",
    0x29: "AND imm",
    0x2A: "ROL A",
    0x2B: "ANC imm",
    0x2C: "BIT abs",
    0x2D: "AND abs",
    0x2E: "ROL abs",
    0x2F: "RLA abs",
    0x30: "BMI branch",
    0x31: "AND (),y",
    0x33: "RLA (),y",
    0x34: "NOP zp,x",
    0x35: "AND zp,x",
    0x36: "ROL zp,x",
    0x37: "RLA zp,x",
    0x38: "SEC",
    0x39: "AND abs,y",
    0x3A: "NOP",
    0x3B: "RLA abs,y",
    0x3C: "NOP abs,x",
    0x3D: "AND abs,x",
    0x3E: "ROL abs,x",
    0x3F: "RLA abs,x",
    0x40: "RTI",
    0x41: "EOR (,x)",
    0x43: "SRE (,x)",
    0x44: "NOP zp",
    0x45: "EOR zp",
    0x46: "LSR zp",
    0x47: "SRE zp",
    0x48: "PHA",
    0x49: "EOR imm",
    0x4A: "LSR A",
    0x4B: "ASR imm",
    0x4C: "JMP abs",
    0x4D: "EOR abs",
    0x4E: "LSR abs",
    0x4F: "SRE abs",
    0x50: "BVC branch",
    0x51: "EOR (),y",
    0x53: "SRE (),y",
    0x54: "NOP zp,x",
    0x55: "EOR zp,x",
    0x56: "LSR zp,x",
    0x57: "SRE zp,x",
    0x58: "CLI",
    0x59: "EOR abs,y",
    0x5A: "NOP",
    0x5B: "SRE abs,y",
    0x5C: "NOP abs,x",
    0x5D: "EOR abs,x",
    0x5E: "LSR abs,x",
    0x5F: "SRE abs,x",
    0x60: "RTS",
    0x61: "ADC (,x)",
    0x63: "RRA (,x)",
    0x64: "NOP zp",
    0x65: "ADC zp",
    0x66: "ROR zp",
    0x67: "RRA zp",
    0x68: "PLA",
    0x69: "ADC imm",
    0x6A: "ROR A",
    0x6B: "ARR",
    0x6C: "JMP ()",
    0x6D: "ADC abs",
    0x6E: "ROR abs",
    0x6F: "RRA abs",
    0x70: "BVS branch",
    0x71: "ADC (),y",
    0x73: "RRA (,y)",
    0x74: "NOP zp,x",
    0x75: "ADC zp,x",
    0x76: "ROR zp,x",
    0x77: "RRA zp,x",
    0x78: "SEI",
    0x79: "ADC abs,y",
    0x7A: "NOP",
    0x7B: "RRA abs,y",
    0x7D: "ADC abs,x",
    0x7E: "ROR abs,x",
    0x7F: "RRA abs,x",
    0x80: "NOP imm",
    0x81: "STA (,x)",
    0x82: "NOP imm",
    0x83: "SAX (,x)",
    0x84: "STY zp",
    0x85: "STA zp",
    0x86: "STX zp",
    0x87: "SAX zp",
    0x88: "DEY",
    0x89: "NOP imm",
    0x8A: "TXA",
    0x8B: "ANE",
    0x8C: "STY abs",
    0x8D: "STA abs",
    0x8E: "STX abs",
    0x8F: "SAX abs",
    0x90: "BCC branch",
    0x91: "STA (),y",
    0x93: "SHA (),y",
    0x94: "STY zp,x",
    0x95: "STA zp,x",
    0x96: "STX zp,y",
    0x97: "SAX zp,y",
    0x98: "TYA",
    0x99: "STA abs,y",
    0x9A: "TXS",
    0x9B: "SHS abs,y",
    0x9C: "SHY abs,x",
    0x9D: "STA abs,x",
    0x9E: "SHX abs,y",
    0x9F: "SHA abs,y",
    0xA0: "LDY imm",
    0xA1: "LDA (,x)",
    0xA2: "LDX imm",
    0xA3: "LAX (,y)",
    0xA4: "LDY zp",
    0xA5: "LDA zp",
    0xA6: "LDX zp",
    0xA7: "LAX zp",
    0xA8: "TAY",
    0xA9: "LDA imm",
    0xAA: "TAX",
    0xAB: "LAX",
    0xAC: "LDY abs",
    0xAD: "LDA abs",
    0xAE: "LDX abs",
    0xAF: "LAX abs",
    0xB0: "BCS branch",
    0xB1: "LDA (),y",
    0xB3: "LAX (),y",
    0xB4: "LDY zp,x",
    0xB5: "LDA zp,x",
    0xB6: "LDX zp,y",
    0xB7: "LAX zp,y",
    0xB8: "CLV",
    0xB9: "LDA abs,y",
    0xBA: "TSX",
    0xBB: "LAS abs,y",
    0xBC: "LDY abs,x",
    0xBD: "LDA abs,x",
    0xBE: "LDX abs,y",
    0xBF: "LAX abs,y",
    0xC0: "CPY imm",
    0xC1: "CMP (,x)",
    0xC2: "NOP imm",
    0xC3: "DCP (,x)",
    0xC4: "CPY zp",
    0xC5: "CMP zp",
    0xC6: "DEC zp",
    0xC7: "DCP zp",
    0xC8: "INY",
    0xC9: "CMP imm",
    0xCA: "DEX",
    0xCB: "SBX imm",
    0xCC: "CPY abs",
    0xCD: "CMP abs",
    0xCE: "DEC abs",
    0xCF: "DCP abs",
    0xD0: "BNE branch",
    0xD1: "CMP (),y",
    0xD3: "DCP (),y",
    0xD4: "NOP zp,x",
    0xD5: "CMP zp,x",
    0xD6: "DEC zp,x",
    0xD7: "DCP zp,x",
    0xD8: "CLD",
    0xD9: "CMP abs,y",
    0xDA: "NOP",
    0xDB: "DCP abs,y",
    0xDC: "NOP abs,x",
    0xDD: "CMP abs,x",
    0xDE: "DEC abs,x",
    0xDF: "DCP abs,x",
    0xE0: "CPX imm",
    0xE1: "SBC (,x)",
    0xE2: "NOP imm",
    0xE3: "ISB (,x)",
    0xE4: "CPX zp",
    0xE5: "SBC zp",
    0xE6: "INC zp",
    0xE7: "ISB zp",
    0xE8: "INX",
    0xE9: "SBC imm",
    0xEA: "NOP",
    0xEB: "SBC imm",
    0xEC: "CPX abs",
    0xED: "SBC abs",
    0xEE: "INC abs",
    0xEF: "ISB abs",
    0xF0: "BEQ branch",
    0xF1: "SBC (),y",
    0xF3: "ISB (),y",
    0xF4: "NOP zpx",
    0xF5: "SBC zp,x",
    0xF6: "INC zp,x",
    0xF7: "ISB zp,x",
    0xF8: "SED",
    0xF9: "SBC abs,y",
    0xFA: "NOP",
    0xFB: "ISB abs,y",
    0xFC: "NOP abs,x",
    0xFD: "SBC abs,x",
    0xFE: "INC abs,x",
    0xFF: "ISB abs,x",
};

function generate6502() {
    "use strict";
    var functions = [];
    for (var i = 0; i < 256; ++i) {
        var opcode = opcodes6502[i];
        if (opcode) {
            functions[i] = compileInstruction2(opcode);
            if (!functions[i]) {
                functions[i] = compileInstruction(opcode);
            }
        }
    }
    return functions;
}

function Disassemble6502(cpu) {
    "use strict";
    this.disassemble = function(addr) {
        var opcode = opcodes6502[cpu.readmem(addr)];
        if (!opcode) { return ["???", addr + 1]; }
        var split = opcode.split(" ");
        if (!split[1]) {
            return [opcode, addr + 1];
        }
        var param = split[1] || "";
        var suffix = "";
        var index = param.match(/(.*),([xy])$/);
        if (index) {
            param = index[1];
            suffix = "," + index[2].toUpperCase();
        }
        switch (param) {
        case "imm":
            return [split[0] + " #$" + hexbyte(cpu.readmem(addr + 1)) + suffix, addr + 2];
        case "abs":
            return [split[0] + " $" + hexword(cpu.readmem(addr + 1) | (cpu.readmem(addr+2)<<8)) + suffix,
                   addr + 3];
        case "branch":
            return [split[0] + " $" + hexword(addr + signExtend(cpu.readmem(addr + 1)) + 2) + suffix,
                   addr + 2];
        case "zp":
            return [split[0] + " $" + hexbyte(cpu.readmem(addr + 1)) + suffix, addr + 2];
        case "(,x)":
            return [split[0] + " ($" + hexbyte(cpu.readmem(addr + 1)) + ", X)" + suffix, addr + 2];
        case "()":
            if (split[0] == "JMP")
                return [split[0] + " ($" + hexword(cpu.readmem(addr + 1) | (cpu.readmem(addr+2)<<8)) + ")" + suffix,
                    addr + 3];
            else
                return [split[0] + " ($" + hexbyte(cpu.readmem(addr + 1)) + ")" + suffix, addr + 2];
        }
        return [opcode, addr + 1];
    };
}
