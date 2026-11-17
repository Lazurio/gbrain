# gbrain pro Lazurio: jak fork držíme a vydáváme

`Lazurio/gbrain` je fork [`garrytan/gbrain`](https://github.com/garrytan/gbrain).
Lazurio z něj instaluje paměťový server do Osobního Prostředí. Fork drží
**přesné stabilní vydání upstreamu a nad ním overlay Lazuria**. Overlay je jen
v této složce `lazurio/`. Kód gbrainu dnes v overlayi žádný není.

## Co fork přidává

| Cesta | Proč |
| --- | --- |
| `lazurio/README.md` | Tento postup. |
| `lazurio/fork-check.sh` | Ověří, že commit je přesný upstream tag a k němu jen overlay. |
| `lazurio/upgrade-test/` | Zkouška přechodu mozku ze starého vydání na nové, na smyšlených datech. |

Když overlay jednou dostane opravu kódu, zapiš ji sem do tabulky i s důvodem
a s odkazem na upstream issue nebo PR. Když upstream stejnou věc opraví,
oprava z overlaye odejde v další synchronizaci. Tak skončil i první commit
forku (stdout pod MCP stdio, #1): upstream ho opravil sám.

## Které vydání bereme

Bereme jen vydání, které upstream povýšil do stabilního kanálu, tedy tag
`v<verze>` se stejnojmenným tagem `stable-v<verze>` na stejném commitu
(`docs/STABILITY.md` upstreamu). Alfa vydání (GitHub pre-release) nebereme.
Nemusí to být nejnovější stabilní vydání: přednost má to, které prošlo
zkouškou přechodu.

## Vydání

1. **Větev.** Z `master` založ `lazurio/sync-v<verze>` a slouč do ní upstream
   tag merge commitem (`git merge --no-ff v<verze>`). Overlay zůstává jen
   v `lazurio/`, takže by merge neměl mít konflikty. Pokud je má, je to nález
   pro review, ne věc k tichému vyřešení.
2. **Kontrola forku.** `lazurio/fork-check.sh v<verze>` musí skončit `ok`.
3. **Zkouška přechodu.** Do prázdné složky mimo repozitář spusť
   `lazurio/upgrade-test/run.sh <složka> github:Lazurio/gbrain#<předchozí tag> github:Lazurio/gbrain#lazurio/sync-v<verze>`.
   Skript postaví mozek na předchozím vydání tak, jak ho zakládá Lazurio
   (PGLite bez embeddingů, vault jako git checkout s pushem, klíče z admin
   API), naplní ho smyšlenými stránkami, odkazy a fakty a převede ho. Musí
   skončit `PASS`. Zkouška hlídá počty a ID, `recall`, `remember`, klíče a jejich
   scopy, rozhraní nástrojů MCP (žádný nástroj ani parametr nesmí zmizet nebo
   se zpřísnit), to, že přechod nesáhne na soubory vaultu, push po zápisu,
   start starého vydání nad migrovanou databází a obnovu ze zálohy.
4. **Pull request** do `master` popiš výstupy obou kontrol, verzí schématu
   databáze před přechodem a po něm a riziky. Review a merge řídí pravidla
   Organizace LazurioDevelopment (review `agentrozjedemeai`). Merge je jen
   merge commit, nikdy squash ani rebase: historie upstreamu musí zůstat
   předkem `master`.
5. **Tag.** Po merge vytvoř na merge commitu v `master` anotovaný tag
   `v<verze>-lazurio.<N>`. N začíná na 1 a roste, když se na stejném upstream
   vydání změní overlay. `lazurio/fork-check.sh v<verze> v<verze>-lazurio.<N>`
   musí projít i na tagu. Tag je neměnný: existující tagy se nepřesouvají ani
   nemažou a do `master` se nic nepushuje silou.
6. **Pin.** Lazurio připíná vydání přesným tagem, commitem a verzí. Změna pinu
   jde vlastním pull requestem a nasazuje se po ringech, nejdřív na zkušební
   Organizaci. Před přechodem každého Prostředí se zálohuje `~/.gbrain`
   a checkout vaultu.

GitHub Actions jsou ve forku vypnuté, aby v něm neběžely workflow upstreamu.
Kontroly proto spouští ten, kdo vydání připravuje, a jejich výstup patří do
pull requestu.

## Cesta zpět

Migrace schématu jsou jen dopředné. Starší gbrain nad novějším schématem podle
upstreamu dál čte a běží, jen odmítne schéma znovu zakládat (`client_behind`).
Zkouška přechodu to u každého vydání ověřuje, ale spoléhat se na to nedá.
Pojistkou je záloha `~/.gbrain` a vaultu pořízená před přechodem: zastavit
server, vrátit zálohu, nainstalovat předchozí tag a server spustit.
