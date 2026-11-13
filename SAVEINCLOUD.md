# Subindo o Agenda de Visitas no Kubernetes da SaveInCloud — do zero

Este guia é para quem tem **só o cluster Kubernetes na SaveInCloud** e uma conta no **GitHub**. Não precisa instalar Docker, kubectl nem ArgoCD no seu computador: a imagem é gerada pelo GitHub e os comandos rodam no **Web SSH** do próprio painel da SaveInCloud.

**Visão geral:**

1. Colocar o código no GitHub → o GitHub gera a imagem do app sozinho.
2. Conferir o cluster e descobrir o endereço do ambiente.
3. Criar o login Google (Google Cloud Console).
4. Ajustar 3 valores na configuração.
5. Aplicar no cluster pelo Web SSH.
6. Testar.

Tempo estimado: 40 a 60 minutos na primeira vez.

---

## Passo 1 — Colocar o código no GitHub e gerar a imagem

1. Entre em <https://github.com/new> e crie o repositório **agendar-visita** (pode ser **Private**). Não marque README nem .gitignore. *(Se o repositório já existe, pule para o item 3.)*
2. No seu computador, descompacte o `agenda-visitas.zip`, abra um terminal na pasta e envie:
   ```bash
   git remote add origin https://github.com/eoliveiralorente/agendar-visita.git
   git push -u origin main
   ```
   *(Sem Git instalado? No GitHub, use "uploading an existing file" e arraste o conteúdo da pasta, incluindo a pasta `.github`.)*
3. No repositório, vá em **Settings → Actions → General → Workflow permissions**, marque **Read and write permissions** e salve.
4. Vá na aba **Actions**. O workflow **build** roda sozinho a cada push (se não rodou, abra o workflow e clique em **Run workflow**). Espere ficar verde ✅ (2 a 4 minutos).
5. A imagem aparece no seu perfil do GitHub, em **Packages → agenda-visitas**. Abra o pacote → **Package settings** → **Change visibility** → **Public**.
   - Assim o cluster baixa a imagem sem senha. A imagem só tem o código do app, nenhum segredo.
   - Prefere deixar privada? Veja o "Anexo: imagem privada" no fim.

## Passo 2 — Conferir o cluster na SaveInCloud

1. Entre no painel da SaveInCloud e localize o ambiente do Kubernetes.
2. Passe o mouse no nó **Control Plane** (ou "Master") e clique em **Web SSH**. Abre um terminal com o `kubectl` já configurado.
3. Rode e anote os resultados:
   ```bash
   kubectl get nodes            # os nós precisam estar "Ready"
   kubectl get ingressclass     # anote o NOME (ex.: nginx, traefik)
   kubectl get storageclass     # precisa ter uma marcada como "(default)"
   ```
   - Se **não houver storageclass "(default)"**, o banco não consegue criar o disco. Nesse caso, me mande a saída do comando.
4. **Endereço do app (opção A, mais simples):** use o domínio do próprio ambiente, que aparece no painel ao lado do nome do ambiente (algo como `https://NOME-DO-AMBIENTE.<domínio da região>`). Esse endereço já tem HTTPS pelo balanceador da plataforma.
   - Se o cluster veio com a aplicação de exemplo ocupando esse endereço, remova-a:
     ```bash
     kubectl get ingress -A        # veja se existe um ingress de exemplo (ex.: helloworld)
     kubectl delete ingress NOME-DO-INGRESS -n NAMESPACE
     ```
   - Quer usar um domínio seu (ex.: `visitas.suaempresa.com.br`)? Veja a "Opção B" no fim. Dá para começar com a opção A e trocar depois.

Anote o endereço final. Nos próximos passos ele aparece como **`https://SEU-ENDERECO`**.

## Passo 3 — Criar o login Google

1. Acesse <https://console.cloud.google.com/> e crie um projeto (ex.: *agenda-visitas*).
2. Menu **APIs e serviços → Biblioteca** → procure **Google Calendar API** → **Ativar**.
3. Menu **APIs e serviços → Tela de consentimento OAuth** (ou "Google Auth Platform"):
   - Nome do app: *Agenda de Visitas*. E-mail de suporte: o seu.
   - Público: **Interno** se a equipe usa Google Workspace da empresa. **Externo** se forem contas @gmail.
   - Em **Acesso a dados / Escopos**, adicione: `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` e `.../auth/calendar.events`.
   - Se escolheu **Externo**: em **Público → Usuários de teste**, adicione o e-mail de cada pessoa que vai usar (até 100).
4. Menu **Credenciais → Criar credenciais → ID do cliente OAuth**:
   - Tipo: **Aplicativo da Web**.
   - **URIs de redirecionamento autorizados:** `https://SEU-ENDERECO/auth/callback`
   - Clique em **Criar** e copie o **ID do cliente** e a **Chave secreta do cliente**.

## Passo 4 — Ajustar a configuração

No GitHub, abra o arquivo `deploy/overlays/saveincloud/kustomization.yaml`, clique no lápis (editar) e troque:

- `https://SEU-AMBIENTE.SEU-DOMINIO-SAVEINCLOUD` → o seu endereço do passo 2 (sem barra no final);
- `ALLOWED_DOMAINS` → o domínio dos e-mails da empresa (ex.: `suaempresa.com.br`), **ou**
- `ALLOWED_EMAILS` → a lista de e-mails liberados, separados por vírgula (ex.: `ana@gmail.com,rafael@gmail.com`).

Depois abra `deploy/overlays/saveincloud/ingress.yaml` e, se o nome anotado no `kubectl get ingressclass` não for `nginx`, troque `ingressClassName: nginx` pelo nome correto.

Clique em **Commit changes**.

## Passo 5 — Aplicar no cluster (Web SSH)

No **Web SSH** do Control Plane:

**5.1 Baixar o projeto**
```bash
git clone https://github.com/eoliveiralorente/agendar-visita.git
cd agendar-visita
```
*(Repositório privado: o Git pede usuário e senha. Use seu usuário do GitHub e, como senha, um token criado em GitHub → Settings → Developer settings → Personal access tokens, com permissão de leitura do repositório.)*

**5.2 Criar o namespace e os segredos** (troque os dois valores do Google pelos do passo 3):
```bash
kubectl create namespace agenda-visitas

PG_PASS=$(openssl rand -hex 16)
kubectl -n agenda-visitas create secret generic agenda-visitas-secrets \
  --from-literal=SESSION_SECRET=$(openssl rand -hex 32) \
  --from-literal=GOOGLE_CLIENT_ID='COLE-AQUI-O-ID-DO-CLIENTE' \
  --from-literal=GOOGLE_CLIENT_SECRET='COLE-AQUI-A-CHAVE-SECRETA' \
  --from-literal=POSTGRES_PASSWORD=$PG_PASS \
  --from-literal=DATABASE_URL="postgres://agenda:$PG_PASS@postgres:5432/agenda"
```
Esses segredos ficam só no cluster. Não coloque esses valores no GitHub.

**5.3 Subir o app e o banco**
```bash
kubectl apply -k deploy/overlays/saveincloud
```

**5.4 Acompanhar**
```bash
kubectl -n agenda-visitas get pods -w
```
Espere `postgres-0` e os dois `agenda-visitas-...` ficarem **Running** e **1/1** (saia com Ctrl+C). Se algo ficar travado:
```bash
kubectl -n agenda-visitas describe pod NOME-DO-POD   # mostra o motivo (imagem, disco, segredo…)
kubectl -n agenda-visitas logs deploy/agenda-visitas # logs do app
```

## Passo 6 — Testar

1. Abra `https://SEU-ENDERECO`.
2. Clique em **Entrar com Google**, escolha a conta e aceite a permissão da agenda.
3. Vá em **Painel → Equipe** e cadastre as pessoas com o **e-mail do Google de cada uma** (quem entra com esse e-mail é reconhecido automaticamente).
4. Crie uma visita de teste com **Criar no Google Calendar** ligado e confira se o evento apareceu na sua agenda.
5. Para trazer a planilha atual: **Leads → Importar planilha**.

---

## Como atualizar o app depois

1. Faça a mudança no GitHub (ou no seu computador e `git push`). O GitHub gera a imagem nova (aba **Actions**, espere ficar verde).
2. No Web SSH:
   ```bash
   kubectl -n agenda-visitas rollout restart deploy/agenda-visitas
   ```
   Se a mudança foi nos arquivos de `deploy/`, rode antes `cd agendar-visita && git pull && kubectl apply -k deploy/overlays/saveincloud`.

## Backup do banco

```bash
kubectl -n agenda-visitas exec statefulset/postgres -- pg_dump -U agenda agenda > backup-$(date +%F).sql
```
Guarde o arquivo fora do cluster.

## Problemas comuns

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Pod em `ImagePullBackOff` | Imagem privada ou nome errado | Deixe o pacote público (passo 1.5) ou veja o anexo |
| `postgres-0` em `Pending` | Sem storageclass padrão | `kubectl get storageclass` e me mande o resultado |
| Pod do app reiniciando | Segredo faltando ou banco ainda subindo | `kubectl -n agenda-visitas logs deploy/agenda-visitas` |
| Google mostra "redirect_uri_mismatch" | Endereço diferente no Google | O URI no Google precisa ser exatamente `https://SEU-ENDERECO/auth/callback`, igual ao `BASE_URL` |
| "Sua conta não tem acesso" | E-mail fora da lista | Ajuste `ALLOWED_DOMAINS`/`ALLOWED_EMAILS`, faça commit, `git pull`, `kubectl apply -k …` e `rollout restart` |
| Google "acesso bloqueado / app não verificado" | Consentimento Externo sem usuário de teste | Adicione o e-mail em Usuários de teste (passo 3.3) |
| `git: command not found` ou `openssl: command not found` no Web SSH | Ferramenta não instalada no nó | Tente `sudo yum install -y git openssl` (ou `sudo apt install -y git openssl`). Se não tiver permissão, me avise que eu monto o passo sem essas ferramentas |
| Página não abre (404/502) | Classe do Ingress errada ou exemplo ocupando o endereço | Confira `kubectl get ingressclass` e `kubectl get ingress -A` |

---

## Opção B — Domínio próprio com HTTPS (Let's Encrypt)

1. No painel da SaveInCloud, em **Alterar topologia** do ambiente, adicione um **IP público** ao nó **worker** (ou a um balanceador dedicado).
2. No seu provedor de DNS, crie um registro **A**: `visitas.suaempresa.com.br` → esse IP público.
3. No **Control Plane → Add-Ons**, instale **Certificate Manager**. Ele instala o cert-manager e um ingress NGINX com a classe `nginx-cert` (e uma aplicação de exemplo, que pode ser removida).
4. No GitHub, em `deploy/overlays/saveincloud/`: apague o `ingress.yaml`, renomeie `ingress-dominio-proprio.yaml.exemplo` para `ingress.yaml` e troque `visitas.suaempresa.com.br` pelo seu domínio. Atualize também o `BASE_URL` no `kustomization.yaml`.
5. No Google Cloud, adicione o novo URI de redirecionamento: `https://visitas.suaempresa.com.br/auth/callback`.
6. No Web SSH: `git pull && kubectl apply -k deploy/overlays/saveincloud && kubectl -n agenda-visitas rollout restart deploy/agenda-visitas`.

Os nomes de menus e add-ons podem variar um pouco conforme a versão do painel.

## Anexo: imagem privada

Se preferir manter o pacote do GHCR privado, crie um token no GitHub com a permissão `read:packages` e rode no Web SSH:
```bash
kubectl -n agenda-visitas create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io --docker-username=eoliveiralorente \
  --docker-password=SEU_TOKEN
kubectl -n agenda-visitas rollout restart deploy/agenda-visitas
```
O Deployment já está configurado para usar esse segredo (`ghcr-pull`) quando ele existir.
