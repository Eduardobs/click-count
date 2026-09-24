# Mais Um

Aplicativo que contabiliza cliques.

Contador coletivo, responsivo e atualizado em tempo real. O front-end é estático
e pode ser servido pelo GitHub Pages; o estado compartilhado fica no Supabase.

## Por que existe um serviço de dados?

O GitHub Pages só hospeda arquivos estáticos. Para todos os visitantes enxergarem
e alterarem o mesmo número, é necessário um serviço externo. Neste projeto:

- o banco incrementa o valor atomicamente, evitando cliques perdidos;
- o navegador apenas pode ler o contador e chamar a operação `+1`;
- atualizações chegam a todas as abas por Realtime;
- o valor é armazenado como texto e incrementado dígito a dígito, sem o limite de
  precisão de 64 bits ou do `Number` do JavaScript.

## Configuração

1. Crie um projeto gratuito em [supabase.com](https://supabase.com).
2. No painel, abra **SQL Editor**, cole o conteúdo de `supabase/setup.sql` e
   execute-o uma vez.
3. Em **Project Settings → API**, copie a URL do projeto e a chave pública
   (`anon` / `publishable`).
4. Preencha os dois valores em `config.js`:

   ```js
   export const SUPABASE_URL = "https://SEU-PROJETO.supabase.co";
   export const SUPABASE_ANON_KEY = "SUA-CHAVE-PUBLICA";
   ```

A chave usada pelo navegador é pública por definição. A segurança não depende de
escondê-la: o SQL ativa RLS, bloqueia escrita direta na tabela e expõe somente a
função que acrescenta exatamente um ao contador.

## Rodar localmente

Módulos ES precisam ser servidos por HTTP. Use qualquer servidor estático, por
exemplo:

```bash
python3 -m http.server 8080
```

Abra `http://localhost:8080`. Para executar os testes das funções de exibição:

```bash
npm test
```

## Publicar no GitHub Pages

Em **Settings → Pages** do repositório:

1. escolha **Deploy from a branch**;
2. selecione a branch `main` e a pasta `/ (root)`;
3. salve e aguarde o endereço publicado.

Não há etapa de build. `index.html`, CSS e JavaScript são publicados diretamente.

## Observação de segurança

O incremento é seguro contra alteração direta do valor, mas o contador é público:
qualquer pessoa pode clicar ou automatizar chamadas à operação. Para uma campanha
com risco de abuso, ative rate limiting/CAPTCHA em uma Edge Function e faça o
front-end chamar essa função em vez do RPC público.
